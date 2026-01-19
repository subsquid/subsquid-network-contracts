// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title exit Queue Library for Portal Pools
/// @notice implements a "conveyor belt" exit queue for fair, Sybil-resistant unstaking
library ExitQueueLib {
    /// @notice exit queue state (stored in PoolStorage)
    struct Queue {
        uint256 totalRequested; // total amount ever requested for exit
        uint256 processedAmount; // total amount processed (capped at totalRequested)
        uint256 lastUpdate; // timestamp of last sync
        uint256 unlockRatePerSecond; // SQD unlocked per second (e.g., 1e18 = 1 SQD/sec)
    }

    /// @notice individual exit ticket (user can have multiple)
    struct Ticket {
        uint256 endPosition; // queue position when this ticket becomes withdrawable
        uint256 amount; // SQD amount in this ticket
        bool withdrawn; // whether already claimed
    }

    /// @notice initialize the queue (call once at pool creation)
    /// @param self the queue state
    /// @param ratePerSecond the unlock rate (SQD per second, typically 1e18 for 18-decimal tokens)
    function initialize(Queue storage self, uint256 ratePerSecond) internal {
        self.totalRequested = 0;
        self.processedAmount = 0;
        self.lastUpdate = block.timestamp;
        self.unlockRatePerSecond = ratePerSecond;
    }

    /// @dev calculates the virtual processed amount based on time elapsed since last update
    /// @param self the queue state
    /// @return the current processed amount, capped at totalRequested
    function _currentProcessed(Queue storage self) internal view returns (uint256) {
        if (self.totalRequested == self.processedAmount) {
            return self.totalRequested;
        }
        // Guard: zero rate means no processing
        if (self.unlockRatePerSecond == 0) {
            return self.processedAmount;
        }

        uint256 dt = block.timestamp - self.lastUpdate;
        uint256 newlyProcessed;

        // Overflow protection: cap dt * unlockRatePerSecond
        unchecked {
            uint256 maxDt = type(uint256).max / self.unlockRatePerSecond;
            if (dt > maxDt) {
                newlyProcessed = type(uint256).max;
            } else {
                newlyProcessed = dt * self.unlockRatePerSecond;
            }
        }

        uint256 theoretical = self.processedAmount + newlyProcessed;

        // cap at totalRequested - the belt cannot move past the last request
        // this prevents instant withdrawals after idle periods
        return theoretical > self.totalRequested ? self.totalRequested : theoretical;
    }

    /// @dev syncs the state to the current block timestamp
    /// @param self The queue state
    function _sync(Queue storage self) internal {
        self.processedAmount = _currentProcessed(self);
        self.lastUpdate = block.timestamp;
    }

    /// @notice get the current processed position in the queue
    /// @param self the queue state
    /// @return the cumulative SQD amount that has been unlocked
    function totalProcessed(Queue storage self) internal view returns (uint256) {
        return _currentProcessed(self);
    }

    /// @notice check if a ticket is fully unlocked and withdrawable
    /// @param self the queue state
    /// @param ticket the exit ticket to check
    /// @return true if the ticket can be withdrawn
    function isUnlocked(Queue storage self, Ticket storage ticket) internal view returns (bool) {
        return !ticket.withdrawn && ticket.amount > 0 && totalProcessed(self) >= ticket.endPosition;
    }

    /// @notice Add a new exit request to the queue
    /// @param self the queue state
    /// @param amount the SQD amount being requested for exit
    /// @return endPosition the queue position when this request will be unlocked
    function enqueue(Queue storage self, uint256 amount) internal returns (uint256 endPosition) {
        _sync(self);

        endPosition = self.totalRequested + amount;
        self.totalRequested = endPosition;
    }

    /// @notice Calculate seconds until a ticket is unlocked
    /// @param self the queue state
    /// @param ticket the exit ticket to check
    /// @return seconds remaining until unlocked, or type(uint256).max if rate is zero
    function secondsUntilUnlocked(Queue storage self, Ticket storage ticket) internal view returns (uint256) {
        uint256 processed = totalProcessed(self);
        if (processed >= ticket.endPosition) {
            return 0;
        }

        // Guard: zero rate means infinite wait (prevents division by zero)
        if (self.unlockRatePerSecond == 0) {
            return type(uint256).max;
        }

        uint256 remaining = ticket.endPosition - processed;
        // use ceiling division to avoid returning 0 when fractional seconds remain
        // formula: ceil(a/b) = (a + b - 1) / b
        return (remaining + self.unlockRatePerSecond - 1) / self.unlockRatePerSecond;
    }

    /// @notice get queue status for a ticket
    /// @param self the queue state
    /// @param ticket the exit ticket
    /// @return processed the total SQD processed by the queue
    /// @return providerEndPos the provider's end position in queue
    /// @return secondsRemaining the seconds remaining until unlocked
    /// @return ready whether ticket is ready for withdrawal
    function getStatus(Queue storage self, Ticket storage ticket)
        internal
        view
        returns (uint256 processed, uint256 providerEndPos, uint256 secondsRemaining, bool ready)
    {
        processed = totalProcessed(self);
        providerEndPos = ticket.endPosition;
        secondsRemaining = secondsUntilUnlocked(self, ticket);
        ready = isUnlocked(self, ticket);
    }

    function getSimulatedUnlockTimestamp(Queue storage self, uint256 simulatedAmount)
        internal
        view
        returns (uint256 unlockTimestamp)
    {
        uint256 processed = totalProcessed(self);
        uint256 simulatedEndPosition = self.totalRequested + simulatedAmount;

        if (processed >= simulatedEndPosition) {
            return block.timestamp;
        }

        uint256 remaining = simulatedEndPosition - processed;

        if (self.unlockRatePerSecond == 0) {
            return type(uint256).max;
        }

        uint256 secondsNeeded = (remaining + self.unlockRatePerSecond - 1) / self.unlockRatePerSecond;
        return block.timestamp + secondsNeeded;
    }
}
