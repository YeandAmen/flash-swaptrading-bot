// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Arb {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address account, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETHArb is IERC20Arb {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IV2FactoryArb {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IV2PairArb {
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address recipient, bytes calldata data) external;
}

interface IV3FactoryArb {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IV3PoolArb {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

interface IV4ManagerArb {
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

interface IAavePoolArb {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
}

interface IMorphoArb {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IBalancerVaultArb {
    function unlock(bytes calldata data) external returns (bytes memory);
    function sendTo(address token, address to, uint256 amount) external;
    function settle(address token, uint256 amountHint) external returns (uint256 credit);
}

/// @notice Atomic WETH -> token -> WETH arbitrage across canonical Ethereum venue factories.
/// @dev v4 accepts only static fees and zero hooks. Routes have no caller-supplied external calldata.
contract FlashArbLogic {
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant UNI_V2 = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address private constant SUSHI_V2 = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac;
    address private constant PANCAKE_V2 = 0x1097053Fd2ea711dad45caCcc45EfF7548fCB362;
    address private constant UNI_V3 = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant SUSHI_V3 = 0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F;
    address private constant PANCAKE_V3 = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address private constant UNI_V4 = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address private constant AAVE_V3 = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant SPARK_LEND = 0xC13e21B648A5Ee794902342038FF3aDAB66BE987;
    address private constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant BALANCER_V3 = 0xbA1333333333a1BA1108E8412f11850A5C319bA9;
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    uint256 private constant MAX_SWAP_AMOUNT = uint256(uint128(type(int128).max));

    uint256 private constant T_LOCK = 0;
    uint256 private constant T_CALLBACK_ADDRESS = 1;
    uint256 private constant T_CALLBACK_KIND = 2;
    uint256 private constant T_CALLBACK_HASH = 3;
    uint256 private constant T_V4_UNLOCK_HASH = 4;
    uint256 private constant T_V4_IN_UNLOCK = 5;

    uint256 private constant V2_CALLBACK = 1;
    uint256 private constant V3_CALLBACK = 2;
    uint256 private constant PANCAKE_CALLBACK = 3;
    uint256 private constant AAVE_CALLBACK = 4;
    uint256 private constant MORPHO_CALLBACK = 5;
    uint256 private constant BALANCER_CALLBACK = 6;
    uint256 private constant PANCAKE_V2_CALLBACK = 7;

    // FlashArbProxy writes ownership to slot zero at deployment. Standalone logic has no owner.
    // Keep this slot and the transient lock layout stable across upgrades.
    address public owner;

    enum Venue { UniswapV2, SushiV2, UniswapV3, SushiV3, PancakeV3, UniswapV4, PancakeV2 }
    enum Funding { BuyPool, AaveV3, MorphoBlue, BalancerV3, SparkLend }

    struct Pool {
        Venue kind;
        address pool;
        uint24 fee;
        int24 tickSpacing;
        bool nativeEth;
    }

    struct Arb {
        Funding funding;
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
        uint256 maximumInput;
        bytes flashRoute;
    }

    struct V4Call {
        Pool pool;
        address token;
        bool buying;
        uint256 amount;
        bytes flashRoute;
    }

    event Arbitrage(address indexed token, address poolA, address poolB, uint256 amountIn, uint256 profit, uint256 tip);
    event FundedBy(Funding funding, uint256 amount, uint256 premium);

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

    /// @return profit WETH value after loan repayment and before builder tip.
    function execute(Arb calldata a) external onlyOwnerAndIdle returns (uint256 profit) {
        require(block.number <= a.maxBlock, "expired");
        require(a.token != WETH && a.token.code.length != 0, "token");
        require(a.amountIn > 0 && a.amountIn <= MAX_SWAP_AMOUNT, "amount");
        require(a.minProfit > 0 && a.minProfit >= a.tip, "floor");
        _validatePool(a.buy, a.token);
        _validatePool(a.sell, a.token);
        if (a.buy.pool == a.sell.pool) {
            require(a.buy.kind == Venue.UniswapV4 && a.sell.kind == Venue.UniswapV4 &&
                (a.buy.fee != a.sell.fee || a.buy.tickSpacing != a.sell.tickSpacing || a.buy.nativeEth != a.sell.nativeEth), "same pool");
        }

        // Return unsolicited assets to the owner before any loan or swap begins.
        _returnBalance(a.token);
        _returnBalance(WETH);
        _returnBalance(address(0));
        _requireEmpty(a.token);

        bytes memory route = abi.encode(a);
        if (a.funding != Funding.BuyPool) {
            _borrowWeth(a, route);
        } else if (_isV2(a.buy.kind)) {
            _buyFlashV2(a, route);
        } else if (a.buy.kind == Venue.UniswapV4) {
            _v4(V4Call(a.buy, a.token, true, a.amountIn, route));
        } else {
            _v3(a.buy, WETH, a.token, a.amountIn, route);
        }

        profit = IWETHArb(WETH).balanceOf(address(this));
        require(profit >= a.minProfit, "unprofitable");
        IWETHArb(WETH).withdraw(profit);
        if (a.tip != 0) _sendEth(block.coinbase, a.tip);
        _returnBalance(address(0));
        _returnBalance(a.token);
        _requireEmpty(a.token);
        emit Arbitrage(a.token, a.buy.pool, a.sell.pool, a.amountIn, profit, a.tip);
    }

    function sweep(address asset) external onlyOwnerAndIdle {
        _returnBalance(asset);
    }

    function _borrowWeth(Arb calldata a, bytes memory route) private {
        address lender;
        if (a.funding == Funding.AaveV3 || a.funding == Funding.SparkLend) {
            lender = a.funding == Funding.AaveV3 ? AAVE_V3 : SPARK_LEND;
            _expect(lender, AAVE_CALLBACK, route);
            IAavePoolArb(lender).flashLoanSimple(address(this), WETH, a.amountIn, route, 0);
        } else if (a.funding == Funding.MorphoBlue) {
            lender = MORPHO_BLUE;
            _expect(lender, MORPHO_CALLBACK, route);
            IMorphoArb(lender).flashLoan(WETH, a.amountIn, route);
        } else {
            lender = BALANCER_V3;
            _expect(lender, BALANCER_CALLBACK, route);
            IBalancerVaultArb(lender).unlock(abi.encodeCall(this.onBalancerV3Loan, (route)));
        }
        require(_load(T_CALLBACK_ADDRESS) == 0, "no loan callback");
        require(IWETHArb(WETH).allowance(address(this), lender) == 0, "unsettled allowance");
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool)
    {
        _consume(AAVE_CALLBACK, params);
        require(initiator == address(this) && asset == WETH, "loan context");
        _settleLoan(abi.decode(params, (Arb)), amount, premium);
        return true;
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        _consume(MORPHO_CALLBACK, data);
        _settleLoan(abi.decode(data, (Arb)), assets, 0);
    }

    function onBalancerV3Loan(bytes calldata data) external {
        _consume(BALANCER_CALLBACK, data);
        Arb memory a = abi.decode(data, (Arb));
        IBalancerVaultArb vault = IBalancerVaultArb(BALANCER_V3);
        vault.sendTo(WETH, address(this), a.amountIn);
        _tradeLoan(a, a.amountIn, a.amountIn);
        _transfer(WETH, BALANCER_V3, a.amountIn);
        require(vault.settle(WETH, a.amountIn) == a.amountIn, "vault settlement");
        emit FundedBy(a.funding, a.amountIn, 0);
    }

    function _tradeLoan(Arb memory a, uint256 amount, uint256 repayment) private {
        require(amount == a.amountIn && IWETHArb(WETH).balanceOf(address(this)) == amount, "loan amount");
        _swap(a.buy, a.token, true, amount);
        _sell(a);
        require(IWETHArb(WETH).balanceOf(address(this)) >= repayment, "loan repayment");
    }

    function _settleLoan(Arb memory a, uint256 amount, uint256 premium) private {
        uint256 repayment = amount + premium;
        _tradeLoan(a, amount, repayment);
        require(IWETHArb(WETH).allowance(address(this), msg.sender) == 0, "loan allowance");
        require(IWETHArb(WETH).approve(msg.sender, repayment), "repay approval");
        emit FundedBy(a.funding, amount, premium);
    }

    function uniswapV2Call(address sender, uint256, uint256, bytes calldata data) external {
        _finishV2(V2_CALLBACK, sender, data);
    }

    function pancakeCall(address sender, uint256, uint256, bytes calldata data) external {
        _finishV2(PANCAKE_V2_CALLBACK, sender, data);
    }

    function _finishV2(uint256 kind, address sender, bytes calldata data) private {
        _consume(kind, data);
        require(sender == address(this), "v2 sender");
        Arb memory a = abi.decode(data, (Arb));
        _sell(a);
        _transfer(WETH, msg.sender, a.amountIn);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _finishV3(V3_CALLBACK, amount0Delta, amount1Delta, data);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _finishV3(PANCAKE_CALLBACK, amount0Delta, amount1Delta, data);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        uint256 expectedHash = _load(T_V4_UNLOCK_HASH);
        require(msg.sender == UNI_V4 && expectedHash != 0 && expectedHash == uint256(keccak256(data)), "v4 callback");
        _store(T_V4_UNLOCK_HASH, 0);
        _store(T_V4_IN_UNLOCK, 1);
        _swapV4Unlocked(abi.decode(data, (V4Call)));
        _store(T_V4_IN_UNLOCK, 0);
        return "";
    }

    function _validatePool(Pool calldata p, address token) private view {
        if (p.kind == Venue.UniswapV4) {
            // The manager independently verifies that the exact PoolKey exists.
            require(p.pool == UNI_V4 && p.tickSpacing > 0 && p.tickSpacing <= 32767 && p.fee < 1_000_000, "v4 key");
            return;
        }
        require(p.pool != address(0) && p.tickSpacing == 0 && !p.nativeEth, "pool parameters");
        if (_isV2(p.kind)) {
            address factory = p.kind == Venue.UniswapV2 ? UNI_V2 : p.kind == Venue.SushiV2 ? SUSHI_V2 : PANCAKE_V2;
            uint24 fee = p.kind == Venue.PancakeV2 ? 2500 : 3000;
            require(p.fee == fee && IV2FactoryArb(factory).getPair(WETH, token) == p.pool, "v2 factory");
        } else {
            address factory = p.kind == Venue.UniswapV3 ? UNI_V3 : p.kind == Venue.SushiV3 ? SUSHI_V3 : PANCAKE_V3;
            require(IV3FactoryArb(factory).getPool(WETH, token, p.fee) == p.pool, "v3 factory");
        }
    }

    function _sell(Arb memory a) private {
        uint256 acquired = IERC20Arb(a.token).balanceOf(address(this));
        require(acquired != 0, "no token bought");
        _swap(a.sell, a.token, false, acquired);
    }

    function _swap(Pool memory p, address token, bool buying, uint256 amountIn) private {
        (address input, address output) = buying ? (WETH, token) : (token, WETH);
        uint256 beforeOutput = IERC20Arb(output).balanceOf(address(this));
        if (_isV2(p.kind)) {
            _swapV2(p, input, output, amountIn);
        } else if (p.kind == Venue.UniswapV4) {
            _v4(V4Call(p, token, buying, amountIn, ""));
        } else {
            _v3(p, input, output, amountIn, "");
        }
        require(IERC20Arb(output).balanceOf(address(this)) > beforeOutput, "no swap output");
    }

    function _buyFlashV2(Arb calldata a, bytes memory data) private {
        (uint112 reserve0, uint112 reserve1,) = IV2PairArb(a.buy.pool).getReserves();
        bool zeroForOne = WETH < a.token;
        uint256 out = zeroForOne ? _v2Out(a.amountIn, reserve0, reserve1, a.buy.fee) : _v2Out(a.amountIn, reserve1, reserve0, a.buy.fee);
        _expect(a.buy.pool, a.buy.kind == Venue.PancakeV2 ? PANCAKE_V2_CALLBACK : V2_CALLBACK, data);
        IV2PairArb(a.buy.pool).swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), data);
        require(_load(T_CALLBACK_ADDRESS) == 0, "no v2 callback");
    }

    function _swapV2(Pool memory p, address input, address output, uint256 amount) private {
        address pool = p.pool;
        (uint112 reserve0, uint112 reserve1,) = IV2PairArb(pool).getReserves();
        bool zeroForOne = input < output;
        uint256 beforeInput = IERC20Arb(input).balanceOf(pool);
        _transfer(input, pool, amount);
        uint256 received = IERC20Arb(input).balanceOf(pool) - beforeInput;
        uint256 out = zeroForOne ? _v2Out(received, reserve0, reserve1, p.fee) : _v2Out(received, reserve1, reserve0, p.fee);
        IV2PairArb(pool).swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "");
    }

    function _v3(Pool memory p, address input, address output, uint256 amount, bytes memory flashRoute) private {
        require(amount <= uint256(type(int256).max), "v3 amount");
        bool zeroForOne = input < output;
        bytes memory data = abi.encode(V3Call(input, zeroForOne, amount, flashRoute));
        _expect(p.pool, p.kind == Venue.PancakeV3 ? PANCAKE_CALLBACK : V3_CALLBACK, data);
        IV3PoolArb(p.pool).swap(address(this), zeroForOne, int256(amount), _priceLimit(zeroForOne), data);
        require(_load(T_CALLBACK_ADDRESS) == 0, "no v3 callback");
    }

    function _finishV3(uint256 kind, int256 delta0, int256 delta1, bytes calldata data) private {
        _consume(kind, data);
        V3Call memory work = abi.decode(data, (V3Call));
        (int256 debit, int256 credit) = work.zeroForOne ? (delta0, delta1) : (delta1, delta0);
        require(debit > 0 && uint256(debit) <= work.maximumInput && credit < 0, "v3 deltas");
        if (work.flashRoute.length != 0) _sell(abi.decode(work.flashRoute, (Arb)));
        _transfer(work.input, msg.sender, uint256(debit));
    }

    function _v4(V4Call memory work) private {
        if (_load(T_V4_IN_UNLOCK) != 0) {
            _swapV4Unlocked(work);
        } else {
            bytes memory data = abi.encode(work);
            _store(T_V4_UNLOCK_HASH, uint256(keccak256(data)));
            IV4ManagerArb(UNI_V4).unlock(data);
            require(_load(T_V4_UNLOCK_HASH) == 0, "no v4 callback");
        }
    }

    function _swapV4Unlocked(V4Call memory work) private {
        require(work.amount <= MAX_SWAP_AMOUNT, "v4 amount");
        address base = work.pool.nativeEth ? address(0) : WETH;
        (address input, address output) = work.buying ? (base, work.token) : (work.token, base);
        bool zeroForOne = input < output;
        IV4ManagerArb.PoolKey memory key = IV4ManagerArb.PoolKey(
            zeroForOne ? input : output, zeroForOne ? output : input, work.pool.fee, work.pool.tickSpacing, address(0)
        );
        IV4ManagerArb manager = IV4ManagerArb(UNI_V4);
        int256 delta = manager.swap(key, IV4ManagerArb.SwapParams(zeroForOne, -int256(work.amount), _priceLimit(zeroForOne)), "");
        (int256 delta0, int256 delta1) = (delta >> 128, int256(int128(delta)));
        (int256 debit, int256 credit) = zeroForOne ? (delta0, delta1) : (delta1, delta0);
        require(debit < 0 && uint256(-debit) <= work.amount && credit > 0, "v4 deltas");
        uint256 received = uint256(credit);
        manager.take(output, address(this), received);
        if (output == address(0)) IWETHArb(WETH).deposit{value: received}();
        if (work.flashRoute.length != 0) _sell(abi.decode(work.flashRoute, (Arb)));
        uint256 owed = uint256(-debit);
        if (input == address(0)) {
            IWETHArb(WETH).withdraw(owed);
            manager.sync(address(0));
            require(manager.settle{value: owed}() == owed, "v4 native settlement");
        } else {
            manager.sync(input);
            _transfer(input, UNI_V4, owed);
            require(manager.settle() == owed, "v4 token settlement");
        }
    }

    function _expect(address sender, uint256 kind, bytes memory data) private {
        require(_load(T_CALLBACK_ADDRESS) == 0, "callback active");
        _store(T_CALLBACK_ADDRESS, uint160(sender));
        _store(T_CALLBACK_KIND, kind);
        _store(T_CALLBACK_HASH, uint256(keccak256(data)));
    }

    function _consume(uint256 kind, bytes calldata data) private {
        require(uint256(uint160(msg.sender)) == _load(T_CALLBACK_ADDRESS) && kind == _load(T_CALLBACK_KIND)
            && uint256(keccak256(data)) == _load(T_CALLBACK_HASH), "callback context");
        _store(T_CALLBACK_ADDRESS, 0);
        _store(T_CALLBACK_KIND, 0);
        _store(T_CALLBACK_HASH, 0);
    }

    function _returnBalance(address asset) private {
        if (asset == address(0)) {
            if (address(this).balance != 0) _sendEth(owner, address(this).balance);
        } else {
            uint256 amount = IERC20Arb(asset).balanceOf(address(this));
            if (amount != 0) _transfer(asset, owner, amount);
        }
    }

    function _requireEmpty(address token) private view {
        require(address(this).balance == 0 && IWETHArb(WETH).balanceOf(address(this)) == 0
            && IERC20Arb(token).balanceOf(address(this)) == 0, "residual balance");
    }

    function _transfer(address asset, address recipient, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeCall(IERC20Arb.transfer, (recipient, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _sendEth(address recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "ETH payout failed");
    }

    function _isV2(Venue kind) private pure returns (bool) {
        return kind == Venue.UniswapV2 || kind == Venue.SushiV2 || kind == Venue.PancakeV2;
    }

    function _v2Out(uint256 amount, uint256 reserveIn, uint256 reserveOut, uint24 fee) private pure returns (uint256) {
        require(amount > 0 && amount <= type(uint112).max && reserveIn > 0 && reserveOut > 0, "v2 amount");
        uint256 afterFee = amount * (1_000_000 - fee);
        return afterFee * reserveOut / (reserveIn * 1_000_000 + afterFee);
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
