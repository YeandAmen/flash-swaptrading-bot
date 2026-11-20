// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FlashArbArbitrum} from "./FlashArbArbitrum.sol";

/// @notice Arbitrum One logic for FlashArbProxy. Owner resolves from proxy storage on delegatecall.
contract FlashArbArbitrumLogic is FlashArbArbitrum {
    // No external account can use the implementation's standalone owner controls.
    constructor() FlashArbArbitrum(address(this)) {}
}
