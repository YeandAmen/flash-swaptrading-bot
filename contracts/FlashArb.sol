// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

interface IWETH9 {
    function withdraw(uint256) external;
}

interface IUniV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IUniV2Pair {
    // uint112 reserves are ABI-encoded as full words, so reading them as uint256 is exact
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title FlashArb: two-pool WETH arbitrage with a flash swap (no capital needed)
/// @notice Pool A fronts TOKEN for WETH we don't have yet (flash swap); the TOKEN is sold on pool B for more WETH;
///         pool A is repaid and the difference is kept. The whole transaction reverts unless the WETH profit is at
///         least `minProfit`, and sent as a Flashbots bundle a reverting transaction is never included, so a miss
///         costs nothing. Only the owner can trigger it; it never holds funds between transactions.
/// @dev    Pure arbitrage between two pools of the same TOKEN/WETH pair. No front-running, no sandwiching.
contract FlashArb {
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint160 private constant MIN_SQRT_RATIO_PLUS_1 = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_1 = 1461446703485210103287273052203988822378723970341;

    // transient storage slots (EIP-1153): they live for one transaction only
    uint256 private constant T_EXPECTED = 0; // the only pool allowed to call back right now
    uint256 private constant T_POOL_A = 1;
    uint256 private constant T_POOL_B = 2;
    uint256 private constant T_TOKEN = 3;
    uint256 private constant T_B_IS_V2 = 4;
    uint256 private constant T_AMOUNT_IN = 5;

    /// @dev slot 0, plain storage: paper-mode eth_call simulations inject it with a state override
    address public owner;

    struct Arb {
        address poolA; // TOKEN is bought here with WETH this pool fronts
        address poolB; // TOKEN is sold here for WETH
        address token;
        bool aIsV2; // true: Uniswap-v2-style pair (0.3% fee); false: Uniswap v3 pool
        bool bIsV2;
        uint256 amountIn; // WETH borrowed from pool A
        uint256 minProfit; // revert unless the WETH profit is at least this (covers builder tip + gas)
        uint256 tip; // ETH paid to the block builder (block.coinbase) on success
        uint256 maxBlock; // revert if mined after this block
    }

    event Arbitrage(address indexed token, address poolA, address poolB, uint256 amountIn, uint256 profit, uint256 tip);

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    /// @return profit WETH profit (before the builder tip), paid out in ETH: `tip` to the builder, the rest to the owner
    function execute(Arb calldata a) external returns (uint256 profit) {
        require(msg.sender == owner, "owner");
        require(block.number <= a.maxBlock, "late");
        require(a.poolA != a.poolB && a.token != WETH, "route");
        require(a.amountIn > 0 && a.amountIn <= uint256(type(int256).max), "amount");
        require(a.minProfit >= a.tip, "tip");

        _tset(T_POOL_A, uint160(a.poolA));
        _tset(T_POOL_B, uint160(a.poolB));
        _tset(T_TOKEN, uint160(a.token));
        _tset(T_B_IS_V2, a.bIsV2 ? 1 : 0);
        _tset(T_AMOUNT_IN, a.amountIn);
        _tset(T_EXPECTED, uint160(a.poolA));

        uint256 start = IERC20Min(WETH).balanceOf(address(this));
        bool w0 = WETH < a.token; // WETH is token0 in every pool of this pair
        if (a.aIsV2) {
            (uint256 r0, uint256 r1,) = IUniV2Pair(a.poolA).getReserves();
            uint256 out = w0 ? _v2Out(a.amountIn, r0, r1) : _v2Out(a.amountIn, r1, r0);
            IUniV2Pair(a.poolA).swap(w0 ? 0 : out, w0 ? out : 0, address(this), hex"01"); // non-empty data = flash swap
        } else {
            // exact input of WETH; selling token0 when WETH is token0
            IUniV3Pool(a.poolA).swap(address(this), w0, int256(a.amountIn), w0 ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1, "");
        }
        _tset(T_EXPECTED, 0);

        uint256 end = IERC20Min(WETH).balanceOf(address(this));
        require(end >= start + a.minProfit, "unprofitable");
        profit = end - start;
        IWETH9(WETH).withdraw(profit);
        if (a.tip > 0) _sendEth(block.coinbase, a.tip);
        _sendEth(msg.sender, profit - a.tip);
        emit Arbitrage(a.token, a.poolA, a.poolB, a.amountIn, profit, a.tip);
    }

    /// @dev Uniswap v2 / SushiSwap flash-swap callback (pool A is a v2 pair): sell the TOKEN on pool B, repay A in WETH.
    function uniswapV2Call(address sender, uint256, uint256, bytes calldata) external {
        require(msg.sender == address(uint160(_tget(T_EXPECTED))) && sender == address(this), "cb");
        _sellOnB();
        // the TOKEN amount pool A sent was computed from exactly `amountIn` WETH with the v2 formula, so this repays it
        _transfer(WETH, msg.sender, _tget(T_AMOUNT_IN));
    }

    /// @dev Uniswap v3 callback. From pool A: it sent TOKEN and is owed WETH. From pool B: it sent WETH and is owed TOKEN.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == address(uint160(_tget(T_EXPECTED))), "cb");
        address token = address(uint160(_tget(T_TOKEN)));
        bool w0 = WETH < token;
        if (msg.sender == address(uint160(_tget(T_POOL_A)))) {
            uint256 owed = uint256(w0 ? amount0Delta : amount1Delta);
            _sellOnB();
            _transfer(WETH, msg.sender, owed);
        } else {
            _transfer(token, msg.sender, uint256(w0 ? amount1Delta : amount0Delta));
        }
    }

    /// @notice Recovers anything left in the contract (it should never hold funds).
    function sweep(address token) external {
        require(msg.sender == owner, "owner");
        if (token == address(0)) _sendEth(owner, address(this).balance);
        else _transfer(token, owner, IERC20Min(token).balanceOf(address(this)));
    }

    /// @dev Sells every TOKEN this contract holds on pool B for WETH.
    function _sellOnB() private {
        address token = address(uint160(_tget(T_TOKEN)));
        address poolB = address(uint160(_tget(T_POOL_B)));
        bool w0 = WETH < token;
        uint256 amt = IERC20Min(token).balanceOf(address(this));
        if (_tget(T_B_IS_V2) == 1) {
            _transfer(token, poolB, amt);
            (uint256 r0, uint256 r1,) = IUniV2Pair(poolB).getReserves();
            (uint256 rT, uint256 rW) = w0 ? (r1, r0) : (r0, r1);
            uint256 inT = IERC20Min(token).balanceOf(poolB) - rT; // what actually arrived (transfer-fee safe)
            uint256 outW = _v2Out(inT, rT, rW);
            IUniV2Pair(poolB).swap(w0 ? outW : 0, w0 ? 0 : outW, address(this), "");
        } else {
            require(amt <= uint256(type(int256).max), "amount");
            _tset(T_EXPECTED, uint160(poolB));
            // exact input of TOKEN; TOKEN is token0 when WETH is not
            IUniV3Pool(poolB).swap(address(this), !w0, int256(amt), w0 ? MAX_SQRT_RATIO_MINUS_1 : MIN_SQRT_RATIO_PLUS_1, "");
        }
    }

    /// @dev Uniswap v2 getAmountOut with the 0.3% fee (also SushiSwap)
    function _v2Out(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 x = amountIn * 997;
        return (x * reserveOut) / (reserveIn * 1000 + x);
    }

    /// @dev transfer that also accepts tokens returning nothing (USDT-style)
    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "eth");
    }

    function _tset(uint256 slot, uint256 value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _tget(uint256 slot) private view returns (uint256 value) {
        assembly {
            value := tload(slot)
        }
    }
}
