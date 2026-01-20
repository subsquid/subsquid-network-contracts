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
        uint256 lastKnownRate; // cached rate to detect changes and sync properly
    }

    /// @notice individual exit ticket (user can have multiple)
    struct Ticket {
        uint256 endPosition; // queue position when this ticket becomes withdrawable
        uint256 amount; // SQD amount in this ticket
        bool withdrawn; // whether already claimed
    }

    /// @notice initialize the queue (call once at pool creation)
    /// @param self the queue state
    /// @param initialRate the initial unlock rate from factory
    function initialize(Queue storage self, uint256 initialRate) internal {
        self.totalRequested = 0;
        self.processedAmount = 0;
        self.lastUpdate = block.timestamp;
        self.lastKnownRate = initialRate;
    }

    /// @dev calculates the virtual processed amount based on time elapsed since last update
    /// @param self the queue state
    /// @param unlockRatePerSecond the unlock rate fetched from factory
    /// @return the current processed amount, capped at totalRequested
    function _currentProcessed(Queue storage self, uint256 unlockRatePerSecond) internal view returns (uint256) {
        if (self.totalRequested == self.processedAmount) {
            return self.totalRequested;
        }
        // Guard: zero rate means no processing
        if (unlockRatePerSecond == 0) {
            return self.processedAmount;
        }

        uint256 dt = block.timestamp - self.lastUpdate;
        uint256 newlyProcessed;

        // Overflow protection: cap dt * unlockRatePerSecond
        unchecked {
            uint256 maxDt = type(uint256).max / unlockRatePerSecond;
            if (dt > maxDt) {
                newlyProcessed = type(uint256).max;
            } else {
                newlyProcessed = dt * unlockRatePerSecond;
            }
        }

        uint256 theoretical = self.processedAmount + newlyProcessed;

        // cap at totalRequested - the belt cannot move past the last request
        // this prevents instant withdrawals after idle periods
        return theoretical > self.totalRequested ? self.totalRequested : theoretical;
    }

    /// @dev syncs the state to the current block timestamp, handling rate changes properly
    /// @param self The queue state
    /// @param currentRate the current unlock rate fetched from factory
    function _sync(Queue storage self, uint256 currentRate) internal {
        // if rate changed, first sync with OLD rate to capture all processing up to now
        // this ensures processedAmount accurately reflects time spent at each rate
        if (currentRate != self.lastKnownRate && self.lastKnownRate > 0) {
            self.processedAmount = _currentProcessed(self, self.lastKnownRate);
            self.lastKnownRate = currentRate;
        } else {
            self.processedAmount = _currentProcessed(self, currentRate);
            if (self.lastKnownRate == 0) {
                self.lastKnownRate = currentRate;
            }
        }
        self.lastUpdate = block.timestamp;
    }

    /// @notice get the current processed position in the queue
    /// @dev handles rate changes by using lastKnownRate for historical calculation
    /// @param self the queue state
    /// @param currentRate the current unlock rate fetched from factory
    /// @return the cumulative SQD amount that has been unlocked
    function totalProcessed(Queue storage self, uint256 currentRate) internal view returns (uint256) {
        // for view functions, we need to simulate proper sync behavior:
        // if rate changed, calculate with OLD rate (what sync would do)
        // then future calculations use new rate (but that's after the sync point)
        if (currentRate != self.lastKnownRate && self.lastKnownRate > 0) {
            return _currentProcessed(self, self.lastKnownRate);
        }
        return _currentProcessed(self, currentRate);
    }

    /// @notice check if a ticket is fully unlocked and withdrawable
    /// @param self the queue state
    /// @param ticket the exit ticket to check
    /// @param unlockRatePerSecond the unlock rate fetched from factory
    /// @return true if the ticket can be withdrawn
    function isUnlocked(Queue storage self, Ticket storage ticket, uint256 unlockRatePerSecond)
        internal
        view
        returns (bool)
    {
        return !ticket.withdrawn && ticket.amount > 0 && totalProcessed(self, unlockRatePerSecond) >= ticket.endPosition;
    }

    /// @notice Add a new exit request to the queue
    /// @param self the queue state
    /// @param amount the SQD amount being requested for exit
    /// @param unlockRatePerSecond the unlock rate fetched from factory
    /// @return endPosition the queue position when this request will be unlocked
    function enqueue(Queue storage self, uint256 amount, uint256 unlockRatePerSecond)
        internal
        returns (uint256 endPosition)
    {
        _sync(self, unlockRatePerSecond);

        endPosition = self.totalRequested + amount;
        self.totalRequested = endPosition;
    }

    /// @notice Calculate seconds until a ticket is unlocked
    /// @param self the queue state
    /// @param ticket the exit ticket to check
    /// @param unlockRatePerSecond the unlock rate fetched from factory
    /// @return seconds remaining until unlocked, or type(uint256).max if rate is zero
    function secondsUntilUnlocked(Queue storage self, Ticket storage ticket, uint256 unlockRatePerSecond)
        internal
        view
        returns (uint256)
    {
        uint256 processed = totalProcessed(self, unlockRatePerSecond);
        if (processed >= ticket.endPosition) {
            return 0;
        }

        // Guard: zero rate means infinite wait (prevents division by zero)
        if (unlockRatePerSecond == 0) {
            return type(uint256).max;
        }

        uint256 remaining = ticket.endPosition - processed;
        // use ceiling division to avoid returning 0 when fractional seconds remain
        // formula: ceil(a/b) = (a + b - 1) / b
        return (remaining + unlockRatePerSecond - 1) / unlockRatePerSecond;
    }

    /// @notice get queue status for a ticket
    /// @param self the queue state
    /// @param ticket the exit ticket
    /// @param unlockRatePerSecond the unlock rate fetched from factory
    /// @return processed the total SQD processed by the queue
    /// @return providerEndPos the provider's end position in queue
    /// @return secondsRemaining the seconds remaining until unlocked
    /// @return ready whether ticket is ready for withdrawal
    function getStatus(Queue storage self, Ticket storage ticket, uint256 unlockRatePerSecond)
        internal
        view
        returns (uint256 processed, uint256 providerEndPos, uint256 secondsRemaining, bool ready)
    {
        processed = totalProcessed(self, unlockRatePerSecond);
        providerEndPos = ticket.endPosition;
        secondsRemaining = secondsUntilUnlocked(self, ticket, unlockRatePerSecond);
        ready = isUnlocked(self, ticket, unlockRatePerSecond);
    }

    /// @notice Simulate unlock timestamp for a hypothetical exit amount
    /// @param self the queue state
    /// @param simulatedAmount the hypothetical exit amount
    /// @param unlockRatePerSecond the unlock rate fetched from factory
    /// @return unlockTimestamp the estimated timestamp when funds would be unlocked
    function getSimulatedUnlockTimestamp(Queue storage self, uint256 simulatedAmount, uint256 unlockRatePerSecond)
        internal
        view
        returns (uint256 unlockTimestamp)
    {
        uint256 processed = totalProcessed(self, unlockRatePerSecond);
        uint256 simulatedEndPosition = self.totalRequested + simulatedAmount;

        if (processed >= simulatedEndPosition) {
            return block.timestamp;
        }

        uint256 remaining = simulatedEndPosition - processed;

        if (unlockRatePerSecond == 0) {
            return type(uint256).max;
        }

        uint256 secondsNeeded = (remaining + unlockRatePerSecond - 1) / unlockRatePerSecond;
        return block.timestamp + secondsNeeded;
    }
}
