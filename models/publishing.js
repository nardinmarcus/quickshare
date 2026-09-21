// Share writes enter through this interface; adapters own transaction isolation.
const PUBLISHING_LOCK = 20828001;

function maintenanceError() {
  return Object.assign(new Error('Share 写入维护中，请稍后重试'), {
    code: 'PUBLISHING_MAINTENANCE', status: 503
  });
}

function createPublishing(repository) {
  return {
    run(operation, { allowPaused = false } = {}) {
      return repository.withPublishingTransaction(async transaction => {
        // The adapter has already acquired the maintenance lock. Check the
        // live setting on that same transaction, never a process-local cache.
        transaction.publishingWritesPaused = await transaction.getPublishingWritesPaused();
        if (transaction.publishingWritesPaused && !allowPaused) throw maintenanceError();
        return operation(transaction);
      });
    }
  };
}

function sendPublishingError(res, error) {
  if (error.code === 'PUBLISHING_MAINTENANCE') {
    res.status(503).json({ success: false, code: error.code, maintenance: true, retryable: true, error: error.message });
    return true;
  }
  if (['55P03', '40P01', '57014'].includes(error.code)) {
    res.status(503).json({ success: false, code: 'PUBLISHING_UNAVAILABLE', retryable: true, error: 'Share 写入暂时不可用，请稍后重试' });
    return true;
  }
  return false;
}

module.exports = { createPublishing, maintenanceError, sendPublishingError, PUBLISHING_LOCK };
