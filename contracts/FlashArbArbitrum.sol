// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20ArbitrumArb {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address account, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWethArbitrumArb is IERC20ArbitrumArb {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IArbSysArb {
    function arbBlockNumber() external view returns (uint256);
}

interface IAaveArbitrumArb {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode)
        external;
}

interface IUniV3ArbitrumFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniV3ArbitrumPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 priceLimit, bytes calldata data)
        external returns (int256, int256);
}

interface IUniV4ArbitrumManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function take(address currency, address recipient, uint256 amount) external;
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

/// @notice Atomic Aave V3 WETH loan and two Uniswap swaps on Arbitrum One.
/// @dev Uses the existing route ABI, limited to Uniswap V3 and static-fee, hookless Uniswap V4.
contract FlashArbArbitrum {
    // Arbitrum One deployments from the Aave Address Book and Uniswap deployment registries.
    address private constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address private constant AAVE_V3 = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address private constant UNI_V3 = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant UNI_V4 = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    IArbSysArb private constant ARB_SYS = IArbSysArb(address(100));
    uint256 private constant MAX_SWAP_AMOUNT = uint256(uint128(type(int128).max));
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    uint8 private constant AAVE_FUNDING = 1;
    uint8 private constant V3_VENUE = 2;
    uint8 private constant V4_VENUE = 5;

    uint256 private constant T_LOCK = 0;
    uint256 private constant T_CALLBACK_SENDER = 1;
    uint256 private constant T_CALLBACK_HASH = 2;
    uint256 private constant T_CALLBACK_KIND = 3;
    uint256 private constant LOAN_CALLBACK = 1;
    uint256 private constant V3_CALLBACK = 2;
    uint256 private constant V4_CALLBACK = 3;

    // Constructor-only assignment keeps runtime bytecode independent of owner.
    address public owner;

    struct Pool {
        uint8 kind;
        address pool;
        uint24 fee;
        int24 tickSpacing;
        bool nativeEth;
    }

    struct Arb {
        uint8 funding;
        address token;
        Pool buy;
        Pool sell;
        uint256 amountIn;
        uint256 minProfit;
        uint256 tip;
        uint256 maxBlock;
    }

    struct V3Call {
        address input;
        bool zeroForOne;
        uint256 amount;
    }

    struct V4Call {
        Pool pool;
        address input;
        address output;
        uint256 amount;
    }

    event Arbitrage(address indexed token, address poolA, address poolB, uint256 amountIn, uint256 profit, uint256 tip);
    event FundedBy(uint8 funding, uint256 amount, uint256 premium);

    constructor(address owner_) {
        require(block.chainid == 42161 && owner_ != address(0), "chain or owner");
        owner = owner_;
    }

    modifier onlyOwnerAndIdle() {
        require(msg.sender == owner, "owner");
        require(_load(T_LOCK) == 0, "busy");
        _store(T_LOCK, 1);
        _;
        _store(T_LOCK, 0);
    }

    receive() external payable {
        require(msg.sender == WETH || msg.sender == UNI_V4, "native sender");
    }

    /// @return profit ETH paid to owner after loan repayment.
    function execute(Arb calldata a) external onlyOwnerAndIdle returns (uint256 profit) {
        // Solidity block.number approximates Ethereum's parent height on Arbitrum.
        require(ARB_SYS.arbBlockNumber() <= a.maxBlock, "expired");
        require(a.funding == AAVE_FUNDING && a.tip == 0, "funding or tip");
        require(a.token != WETH && a.token.code.length != 0, "token");
        require(a.amountIn > 0 && a.amountIn <= MAX_SWAP_AMOUNT && a.minProfit > 0, "amount or floor");
        _validatePool(a.buy, a.token);
        _validatePool(a.sell, a.token);
        if (a.buy.pool == a.sell.pool) {
            require(a.buy.kind == V4_VENUE && a.sell.kind == V4_VENUE
                && (a.buy.fee != a.sell.fee || a.buy.tickSpacing != a.sell.tickSpacing || a.buy.nativeEth != a.sell.nativeEth),
                "same pool");
        }

        // Keep unsolicited balances out of the profit calculation.
        _returnBalance(a.token);
        _returnBalance(WETH);
        _returnBalance(address(0));
        _requireEmpty(a.token);

        bytes memory data = abi.encode(a);
        _expect(AAVE_V3, LOAN_CALLBACK, data);
        IAaveArbitrumArb(AAVE_V3).flashLoanSimple(address(this), WETH, a.amountIn, data, 0);
        _requireConsumed();
        require(IWethArbitrumArb(WETH).allowance(address(this), AAVE_V3) == 0, "unsettled allowance");

        profit = IWethArbitrumArb(WETH).balanceOf(address(this));
        require(profit >= a.minProfit, "unprofitable");
        IWethArbitrumArb(WETH).withdraw(profit);
        _returnBalance(address(0));
        _requireEmpty(a.token);
        emit Arbitrage(a.token, a.buy.pool, a.sell.pool, a.amountIn, profit, 0);
    }

    function sweep(address asset) external onlyOwnerAndIdle {
        _returnBalance(asset);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool)
    {
        _consume(LOAN_CALLBACK, params);
        Arb memory a = abi.decode(params, (Arb));
        require(initiator == address(this) && asset == WETH && amount == a.amountIn
            && IWethArbitrumArb(WETH).balanceOf(address(this)) == amount, "loan context");
        _swap(a.buy, a.token, true, amount);
        _swap(a.sell, a.token, false, IERC20ArbitrumArb(a.token).balanceOf(address(this)));
        uint256 repayment = amount + premium;
        require(IWethArbitrumArb(WETH).balanceOf(address(this)) >= repayment + a.minProfit, "unprofitable");
        require(IWethArbitrumArb(WETH).approve(AAVE_V3, repayment), "repay approval");
        emit FundedBy(a.funding, amount, premium);
        return true;
    }

    function uniswapV3SwapCallback(int256 delta0, int256 delta1, bytes calldata data) external {
        _consume(V3_CALLBACK, data);
        V3Call memory work = abi.decode(data, (V3Call));
        (int256 debit, int256 credit) = work.zeroForOne ? (delta0, delta1) : (delta1, delta0);
        require(debit == int256(work.amount) && credit < 0, "v3 deltas");
        _transfer(work.input, msg.sender, work.amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        _consume(V4_CALLBACK, data);
        V4Call memory work = abi.decode(data, (V4Call));
        bool zeroForOne = work.input < work.output;
        IUniV4ArbitrumManager.PoolKey memory key = IUniV4ArbitrumManager.PoolKey(
            zeroForOne ? work.input : work.output, zeroForOne ? work.output : work.input,
            work.pool.fee, work.pool.tickSpacing, address(0)
        );
        IUniV4ArbitrumManager manager = IUniV4ArbitrumManager(UNI_V4);
        int256 value = manager.swap(
            key, IUniV4ArbitrumManager.SwapParams(zeroForOne, -int256(work.amount), _priceLimit(zeroForOne)), ""
        );
        (int256 delta0, int256 delta1) = (value >> 128, int256(int128(value)));
        (int256 debit, int256 credit) = zeroForOne ? (delta0, delta1) : (delta1, delta0);
        require(debit == -int256(work.amount) && credit > 0, "v4 deltas");
        uint256 received = uint256(credit);
        manager.take(work.output, address(this), received);
        if (work.output == address(0)) IWethArbitrumArb(WETH).deposit{value: received}();
        manager.sync(work.input);
        if (work.input == address(0)) {
            IWethArbitrumArb(WETH).withdraw(work.amount);
            require(manager.settle{value: work.amount}() == work.amount, "v4 native settlement");
        } else {
            _transfer(work.input, UNI_V4, work.amount);
            require(manager.settle() == work.amount, "v4 token settlement");
        }
        return "";
    }

    function _validatePool(Pool calldata p, address token) private view {
        if (p.kind == V4_VENUE) {
            // The manager must resolve the real key for the selected pair, fee and tick spacing.
            require(p.pool == UNI_V4 && p.tickSpacing > 0 && p.tickSpacing <= 32767 && p.fee < 1_000_000, "v4 key");
        } else {
            require(p.kind == V3_VENUE && p.pool != address(0) && p.tickSpacing == 0 && !p.nativeEth
                && IUniV3ArbitrumFactory(UNI_V3).getPool(WETH, token, p.fee) == p.pool, "v3 pool");
        }
    }

    function _swap(Pool memory p, address token, bool buying, uint256 amount) private {
        require(amount > 0 && amount <= MAX_SWAP_AMOUNT, "swap amount");
        (address input, address output) = buying ? (WETH, token) : (token, WETH);
        uint256 beforeOutput = IERC20ArbitrumArb(output).balanceOf(address(this));
        if (p.kind == V4_VENUE) {
            address base = p.nativeEth ? address(0) : WETH;
            bytes memory data = abi.encode(V4Call(p, buying ? base : token, buying ? token : base, amount));
            _expect(UNI_V4, V4_CALLBACK, data);
            IUniV4ArbitrumManager(UNI_V4).unlock(data);
        } else {
            bool zeroForOne = input < output;
            bytes memory data = abi.encode(V3Call(input, zeroForOne, amount));
            _expect(p.pool, V3_CALLBACK, data);
            IUniV3ArbitrumPool(p.pool).swap(address(this), zeroForOne, int256(amount), _priceLimit(zeroForOne), data);
        }
        _requireConsumed();
        require(IERC20ArbitrumArb(output).balanceOf(address(this)) > beforeOutput, "no swap output");
    }

    function _expect(address sender, uint256 kind, bytes memory data) private {
        _requireConsumed();
        _store(T_CALLBACK_SENDER, uint160(sender));
        _store(T_CALLBACK_HASH, uint256(keccak256(data)));
        _store(T_CALLBACK_KIND, kind);
    }

    function _consume(uint256 kind, bytes calldata data) private {
        require(_load(T_LOCK) == 1 && _load(T_CALLBACK_SENDER) == uint160(msg.sender)
            && _load(T_CALLBACK_KIND) == kind && _load(T_CALLBACK_HASH) == uint256(keccak256(data)), "callback context");
        _store(T_CALLBACK_SENDER, 0);
        _store(T_CALLBACK_HASH, 0);
        _store(T_CALLBACK_KIND, 0);
    }

    function _requireConsumed() private view {
        require(_load(T_CALLBACK_SENDER) == 0, "callback pending");
    }

    function _returnBalance(address asset) private {
        if (asset == address(0)) {
            if (address(this).balance != 0) {
                (bool ok,) = owner.call{value: address(this).balance}("");
                require(ok, "ETH payout failed");
            }
        } else {
            uint256 amount = IERC20ArbitrumArb(asset).balanceOf(address(this));
            if (amount != 0) _transfer(asset, owner, amount);
        }
    }

    function _requireEmpty(address token) private view {
        require(address(this).balance == 0 && IWethArbitrumArb(WETH).balanceOf(address(this)) == 0
            && IERC20ArbitrumArb(token).balanceOf(address(this)) == 0, "residual balance");
    }

    function _transfer(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeCall(IERC20ArbitrumArb.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _priceLimit(bool zeroForOne) private pure returns (uint160) {
        return zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
    }

    function _load(uint256 key) private view returns (uint256 value) {
        assembly ("memory-safe") { value := tload(key) }
    }

    function _store(uint256 key, uint256 value) private {
        assembly ("memory-safe") { tstore(key, value) }
    }
}
