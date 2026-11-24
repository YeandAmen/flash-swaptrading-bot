// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Local integration fixtures only. These contracts must never be deployed as
// trading infrastructure. The retained FlashArb contracts are not modified.
interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}
interface Callback {
    function uniswapV2Call(address, uint256, uint256, bytes calldata) external;
}
contract MockToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw");
    }
}
contract MockFactory {
    address public pair;
    function getPair(address, address) external view returns (address) { return pair; }
}
contract MockPair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    bool private locked;
    constructor(address token, address weth, uint112 tokenReserve, uint112 wethReserve) {
        bool first = token < weth;
        token0 = first ? token : weth;
        token1 = first ? weth : token;
        r0 = first ? tokenReserve : wethReserve;
        r1 = first ? wethReserve : tokenReserve;
    }
    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, 0); }
    function swap(uint256 a0, uint256 a1, address to, bytes calldata data) external {
        require(!locked && (a0 > 0 || a1 > 0), "swap");
        locked = true;
        require(a0 < r0 && a1 < r1, "liquidity");
        if (a0 != 0) require(Token(token0).transfer(to, a0));
        if (a1 != 0) require(Token(token1).transfer(to, a1));
        if (data.length != 0) Callback(to).uniswapV2Call(msg.sender, a0, a1, data);
        uint256 b0 = Token(token0).balanceOf(address(this));
        uint256 b1 = Token(token1).balanceOf(address(this));
        uint256 i0 = b0 > uint256(r0) - a0 ? b0 - (uint256(r0) - a0) : 0;
        uint256 i1 = b1 > uint256(r1) - a1 ? b1 - (uint256(r1) - a1) : 0;
        require((b0 * 1000 - i0 * 3) * (b1 * 1000 - i1 * 3) >= uint256(r0) * r1 * 1_000_000, "invariant");
        r0 = uint112(b0);
        r1 = uint112(b1);
        locked = false;
    }
}
