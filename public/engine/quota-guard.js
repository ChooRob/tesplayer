// Native media loaders do not reliably expose structured HTTP error bodies.
// Check the signed-in account before loading, and again after a load failure.
export function createQuotaGuard({fetcher=fetch,onExceeded,onStreamLimit}) {
  return async error => {
    if (error?.code === 'ACCOUNT_STREAM_LIMIT' && onStreamLimit) {
      onStreamLimit(); return true;
    }
    if(error?.code==='QUOTA_EXCEEDED') {
      onExceeded(error.resetAt);return true;
    }
    try {
      const response=await fetcher('/api/auth/me',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)return false;
      const {quota,accountStreamInUse}=await response.json();
      if(quota && Number.isFinite(quota.remainingSeconds) && quota.remainingSeconds<=0) {
        onExceeded(quota.resetAt);return true;
      }
      if (accountStreamInUse && onStreamLimit) {
        onStreamLimit(); return true;
      }
    }catch{/* The stream endpoint still enforces quota if the preflight fails. */}
    return false;
  };
}
