// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FlashArbArbitrumLogic} from "./FlashArbArbitrumLogic.sol";
import {IERC20ArbitrumArb, IArbSysArb, IUniV3ArbitrumFactory} from "./FlashArbArbitrum.sol";

interface IMorphoArbitrumPath {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IAeroPathFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

interface IPathPoolFee {
    function fee() external view returns (uint24);
}

interface IUniPathRouter {
    struct Single {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(Single calldata params) external payable returns (uint256);
}

interface IAeroPathRouter {
    struct Single {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(Single calldata params) external payable returns (uint256);
}

/// @notice Adds release-pinned Morpho routes to the existing Aave two-swap executor.
contract FlashArbArbitrumLogicV2 is FlashArbArbitrumLogic {
    address private constant PATH_WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address private constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address private constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    address private constant USDG = 0x004B506865409877C9fA29bfb1ebA929984B9bbC;
    address private constant MORPHO = 0x6c247b1F6182318877311737BaC0844bAa518F5e;
    address private constant UNI_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant UNI_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address private constant AERO_FACTORY = 0x88a60ee77392577c355C0acb2A8d476D5a4EC03a;
    address private constant AERO_ROUTER = 0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418;
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 private constant MORPHO_CONTEXT = keccak256("FlashArbArbitrumLogicV2.MorphoContext");

    struct Leg { uint8 kind; address pool; address tokenOut; int24 tickSpacing; }
    struct Path { address asset; uint256 amountIn; uint256 minProfit; uint256 maxBlock; Leg[] legs; }

    event PathArbitrage(address indexed asset, address indexed recipient, uint256 amountIn, uint256 profit, uint8 hops);

    function executePath(bytes32 expectedRelease, Path calldata path) external onlyOwnerAndIdle returns (uint256 profit) {
        bytes32 implementationSlot = IMPLEMENTATION_SLOT;
        address implementation;
        assembly ("memory-safe") { implementation := sload(implementationSlot) }
        require(implementation != address(0) && implementation.codehash == expectedRelease, "wrong path release");
        require(IArbSysArb(address(100)).arbBlockNumber() <= path.maxBlock, "expired");
        require(path.asset == USDC || path.asset == PATH_WETH, "loan asset");
        require(path.amountIn > 0 && path.amountIn <= uint256(uint128(type(int128).max)) && path.minProfit > 0, "amount or floor");
        require(path.legs.length >= 3 && path.legs.length <= 4, "path length");
        // Every output appears once. Pre-existing gifts go to the owner before borrowing.
        for (uint256 i; i < path.legs.length; ++i) {
            Leg calldata leg = path.legs[i];
            require(leg.tokenOut == USDC || leg.tokenOut == PATH_WETH || leg.tokenOut == ARB || leg.tokenOut == USDG, "path token");
            require((leg.tokenOut == path.asset) == (i == path.legs.length - 1), "path cycle");
            for (uint256 j; j < i; ++j) {
                require(leg.tokenOut != path.legs[j].tokenOut && leg.pool != path.legs[j].pool, "repeated leg");
            }
            uint256 gift = IERC20ArbitrumArb(leg.tokenOut).balanceOf(address(this));
            if (gift != 0) require(IERC20ArbitrumArb(leg.tokenOut).transfer(owner, gift), "token gift");
        }
        if (address(this).balance != 0) {
            (bool sent,) = owner.call{value: address(this).balance}("");
            require(sent, "ETH gift");
        }

        bytes memory data = abi.encode(path);
        bytes32 context = MORPHO_CONTEXT;
        bytes32 expected = keccak256(data);
        assembly ("memory-safe") { tstore(context, expected) }
        IMorphoArbitrumPath(MORPHO).flashLoan(path.asset, path.amountIn, data);
        bytes32 remaining;
        assembly ("memory-safe") { remaining := tload(context) }
        IERC20ArbitrumArb asset = IERC20ArbitrumArb(path.asset);
        require(remaining == 0 && asset.allowance(address(this), MORPHO) == 0, "loan unsettled");
        profit = asset.balanceOf(address(this));
        require(profit >= path.minProfit && asset.transfer(owner, profit), "profit payout");
        for (uint256 i; i < path.legs.length; ++i) {
            require(IERC20ArbitrumArb(path.legs[i].tokenOut).balanceOf(address(this)) == 0, "path residual");
        }
        require(address(this).balance == 0, "ETH residual");
        emit PathArbitrage(path.asset, owner, path.amountIn, profit, uint8(path.legs.length));
    }

    function onMorphoFlashLoan(uint256 amount, bytes calldata data) external {
        bytes32 expected;
        bytes32 context = MORPHO_CONTEXT;
        assembly ("memory-safe") { expected := tload(context) }
        require(msg.sender == MORPHO && expected != 0 && expected == keccak256(data), "morpho context");
        assembly ("memory-safe") { tstore(context, 0) }
        Path memory path = abi.decode(data, (Path));
        IERC20ArbitrumArb asset = IERC20ArbitrumArb(path.asset);
        require(amount == path.amountIn && asset.balanceOf(address(this)) == amount, "loan balance");
        address input = path.asset;
        uint256 quantity = amount;
        for (uint256 i; i < path.legs.length; ++i) {
            quantity = _pathSwap(input, quantity, path.legs[i]);
            input = path.legs[i].tokenOut;
        }
        require(quantity >= amount + path.minProfit && asset.approve(MORPHO, amount), "unprofitable");
        emit FundedBy(2, amount, 0);
    }

    function _pathSwap(address input, uint256 quantity, Leg memory leg) private returns (uint256 out) {
        address router;
        uint24 fee;
        if (leg.kind == 2) {
            fee = IPathPoolFee(leg.pool).fee();
            require(leg.tickSpacing == 0 && IUniV3ArbitrumFactory(UNI_FACTORY).getPool(input, leg.tokenOut, fee) == leg.pool, "v3 pool");
            router = UNI_ROUTER;
        } else {
            require(leg.kind == 6 && leg.pool != address(0) && leg.tickSpacing > 0
                && IAeroPathFactory(AERO_FACTORY).getPool(input, leg.tokenOut, leg.tickSpacing) == leg.pool, "aero pool");
            router = AERO_ROUTER;
        }
        IERC20ArbitrumArb source = IERC20ArbitrumArb(input);
        require(source.balanceOf(address(this)) == quantity && source.approve(router, quantity), "swap input");
        if (leg.kind == 2) {
            out = IUniPathRouter(router).exactInputSingle(IUniPathRouter.Single(input, leg.tokenOut, fee, address(this), quantity, 1, 0));
        } else {
            out = IAeroPathRouter(router).exactInputSingle(IAeroPathRouter.Single(input, leg.tokenOut, leg.tickSpacing, address(this), block.timestamp, quantity, 1, 0));
        }
        require(out > 0 && out == IERC20ArbitrumArb(leg.tokenOut).balanceOf(address(this))
            && source.balanceOf(address(this)) == 0 && source.allowance(address(this), router) == 0, "swap balances");
    }
}
