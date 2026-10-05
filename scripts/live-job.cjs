// An acceptance run must prove it sent a new request, rather than report an old
// persisted waiting job returned by the product's intentional task coalescing.
async function startFreshJob(core, params) {
  const requestedAt = Date.now();
  let started = await core.call('sync.start', params);
  if (!started.created) {
    const existing = await core.call('sync.get', {job_id: started.job_id});
    if (existing.state !== 'waiting') throw new Error('验收遇到已有执行任务，未产生新请求；请等待该任务结束。');
    if (existing.mode !== (params.mode || 'refresh') || (params.item_key && existing.item_key !== params.item_key)) {
      await core.call('sync.cancel', {job_id:existing.id});
      started = await core.call('sync.start', params);
    } else {
      started = await core.call('sync.retry', {job_id: existing.id, ...(params.page_budget ? {page_budget: params.page_budget} : {})});
    }
    if (started.job_id === existing.id) throw new Error('验收重试仍返回旧任务，不能作为新采集结果。');
  }
  if (!started.created) throw new Error('验收未创建新任务，不能复用旧结果。');
  const fresh = await core.call('sync.get', {job_id: started.job_id});
  if (Date.parse(fresh.created_at) < requestedAt - 1000 || !Number.isFinite(Date.parse(fresh.created_at))) {
    throw new Error('验收任务时间早于本次请求，不能作为新结果。');
  }
  return started;
}
function jobEvidence(job) {
  const evidence = {jobId:job.id,createdAt:job.created_at,updatedAt:job.updated_at,state:job.state,
    mode:job.mode,pageBudget:job.page_budget,pages:job.pages,items:job.items,newItems:job.new_items,
    itemErrors:job.item_errors,error:job.error,coverage:job.coverage};
  if (job.state !== 'succeeded' || job.error || job.item_errors) {
    throw Object.assign(new Error(job.error?.message || job.state),{code:job.error?.code,evidence});
  }
  return evidence; // A successful window read still does not prove full-history coverage.
}
module.exports = {startFreshJob, jobEvidence};
