'use strict';
// 回归测试: 路径枚举触顶(200 条)不得漏判实际带电路径。
//
// 拓扑(星形, 所有路径等长, 保证是“数量上限”而非“长度上限”先触发):
//   同一启用电源 S -> 总线开关 B, B 下游 201 条支路:
//   B -> K_i(tagged) -> D(i=0..199) 共 200 条被挂牌截断支路;
//   B -> D 为第 201 条支路, 不挂牌、直达设备 -> 实际带电。
// 旧逻辑 DFS 在挂牌支路处各产生一条 blockedPath, 满 200 条后停止, 漏掉直达支路,
// 许可被误判为已隔离。修复后精确可达性判定必须拒绝申请, 且至少返回一条带电路径。
const BASE = process.env.BASE || 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}

async function call(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const OP = { actor: '回归操作员', role: 'operator' };
const ADMIN = { actor: '回归管理员', role: 'admin' };

const TAGGED_BRANCHES = 200; // 与 graph.js MAX_PATHS 相同, 确保枚举恰在直达支路前触顶

async function addNode(rev, kind, name) {
  const r = await call('POST', '/api/admin/nodes', { ...ADMIN, revision: rev, kind, name });
  if (r.status !== 200) throw new Error(`新增节点失败 ${name}: ${r.status} ${JSON.stringify(r.data.error)}`);
  return { id: r.data.snapshot.nodes.find((n) => n.name === name).id, rev: r.data.revision };
}

async function addEdge(rev, from, to) {
  const r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: from, to_node: to });
  if (r.status !== 200) throw new Error(`新增接线失败 ${from}->${to}: ${r.status} ${JSON.stringify(r.data.error)}`);
  return r.data.revision;
}

(async () => {
  let { data: s } = await call('GET', '/api/state');
  let rev = s.revision;

  // 1. 搭拓扑(星形: S -> B, B 分出 201 条支路, 每条仅 4 个节点)
  console.log('\n[R1] 构造触顶拓扑: 200 条挂牌截断支路 + 1 条直达支路');
  let t = await addNode(rev, 'source', '回归电源S'); const S = t.id; rev = t.rev;
  t = await addNode(rev, 'switch', '回归总线开关B'); const B = t.id; rev = t.rev;
  t = await addNode(rev, 'device', '回归设备D'); const D = t.id; rev = t.rev;
  rev = await addEdge(rev, S, B);

  const switchIds = [];
  for (let i = 0; i < TAGGED_BRANCHES; i++) {
    t = await addNode(rev, 'switch', `回归挂牌K${i}`);
    switchIds.push(t.id); rev = t.rev;
    rev = await addEdge(rev, B, t.id);
    rev = await addEdge(rev, t.id, D);
  }
  // 第 201 条: 总线直达设备(无挂牌)
  rev = await addEdge(rev, B, D);
  const bus = B;
  ok(true, '拓扑搭建完成(201 条支路)');

  // 2. 给 200 个支路开关挂牌(先分闸)
  console.log('\n[R2] 200 个支路开关全部 分闸+挂牌');
  for (const sw of switchIds) {
    let r = await call('POST', `/api/switches/${sw}/open`, { ...OP, revision: rev });
    if (r.status !== 200) throw new Error(`分闸失败 ${sw}: ${r.status}`);
    rev = r.data.revision;
    r = await call('POST', `/api/switches/${sw}/tag`, { ...OP, revision: rev });
    if (r.status !== 200) throw new Error(`挂牌失败 ${sw}: ${r.status}`);
    rev = r.data.revision;
  }
  ok(true, '200 个支路开关均已挂牌');

  // 3. 诊断接口: 枚举触顶必须标记 truncated, 且 isolated 必须为 false
  console.log('\n[R3] 路径诊断: 截断被标记, 隔离判定仍为未隔离');
  let r = await call('GET', `/api/devices/${D}/paths`);
  ok(r.status === 200, '诊断接口 200');
  ok(r.data.isolated === false, 'isolated=false(精确判定发现直达支路)');
  ok(r.data.totalTruncated === true, 'totalTruncated=true(枚举达到 200 条上限)');
  ok(r.data.truncated === true, 'truncated=true(诊断展示已截断)');
  ok(r.data.blockedPaths.length === 200,
    `前 200 条均为被挂牌切断路径(${r.data.blockedPaths.length} 条), 直达支路是第 201 条`);
  ok(r.data.maxPaths === 200 && r.data.maxPathLen === 64, '返回上限说明');
  const live = r.data.livePaths;
  ok(Array.isArray(live) && live.length === 1,
    `枚举触顶漏掉的第 201 条由精确判定补入(${live.length} 条 witness)`);
  const reachesD = live.some((p) => p.nodes[0].name === '回归电源S'
    && p.nodes[p.nodes.length - 1].name === '回归设备D'
    && p.nodes.every((n) => !n.tagged));
  ok(reachesD, '带电路径从启用电源直达设备且不含挂牌开关');

  // 4. 申请许可: 必须被拒绝(旧 bug 会误放行)
  console.log('\n[R4] 申请许可 -> 422 PERMIT_NOT_ISOLATED(旧实现会错误生效)');
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D });
  ok(r.status === 422, 'HTTP 422');
  ok(r.data.error.code === 'PERMIT_NOT_ISOLATED', '错误码 PERMIT_NOT_ISOLATED');
  ok(r.data.truncated === true, '响应携带截断标记');
  ok(Array.isArray(r.data.livePaths) && r.data.livePaths.length >= 1,
    `拒绝时至少返回一条实际带电路径(${r.data?.livePaths?.length || 0} 条)`);
  const rejectPath = r.data.livePaths.find((p) =>
    p.nodes[p.nodes.length - 1].name === '回归设备D');
  ok(!!rejectPath && rejectPath.nodes.every((n) => !n.tagged),
    '拒绝路径真实到达设备且无挂牌节点');

  // 5. 有效许可期间: 拆掉直达支路后许可可以生效; 再架回直达支路(第 201 条)必须被保护拒绝
  console.log('\n[R5] 有效许可保护: 枚举触顶时改线恢复来电也必须拒绝');
  const liveEdge = (await call('GET', '/api/state')).data.edges
    .find((e) => e.from_node === bus && e.to_node === D);
  r = await call('DELETE', `/api/admin/edges/${liveEdge.id}`, { ...ADMIN, revision: rev });
  ok(r.status === 200, '拆除直达支路(只减通路, 允许)'); rev = r.data.revision;

  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D });
  ok(r.status === 200, `许可 #${r.data?.permit_id} 生效(200 条支路全部挂牌切断)`);
  rev = r.data.revision;
  const permitId = r.data.permit_id;

  // 重新架回直达支路: 旧逻辑 validateActivePermits 同样枚举触顶, 会漏判而放行
  r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: bus, to_node: D });
  ok(r.status === 422 && r.data.error.code === 'ISOLATION_VIOLATION',
    '改线使设备重新来电 -> 422 ISOLATION_VIOLATION(整体拒绝)');
  const v = r.data.violations && r.data.violations.find((x) => x.permit_id === permitId);
  ok(!!v && Array.isArray(v.livePaths) && v.livePaths.length >= 1,
    '返回受影响许可及至少一条带电路径');
  ok(v && v.truncated === true, 'violation 携带截断标记');
  const vpath = v && v.livePaths.find((p) => p.nodes[p.nodes.length - 1].name === '回归设备D');
  ok(!!vpath && vpath.nodes.every((n) => !n.tagged), '保护拒绝路径真实带电');

  // 事务回滚 + revision 不变
  const after = await call('GET', '/api/state');
  ok(after.data.revision === rev, '修订号不变(事务回滚)');
  ok(!after.data.edges.some((e) => e.from_node === bus && e.to_node === D),
    '被拒绝的接线未写入');

  // 6. 解牌保护: 在触顶拓扑下解牌任意支路开关同样必须被拒绝
  console.log('\n[R6] 有效许可期间解牌(枚举触顶) -> 拒绝并给出来电路径');
  r = await call('POST', `/api/switches/${switchIds[0]}/untag`, { ...OP, revision: rev });
  ok(r.status === 422 && r.data.error.code === 'ISOLATION_VIOLATION', '解牌 -> 422 整体拒绝');
  const v2 = r.data.violations && r.data.violations.find((x) => x.permit_id === permitId);
  ok(!!v2 && v2.livePaths.length >= 1
    && v2.livePaths.some((p) => p.nodes.some((n) => n.name === '回归挂牌K0')),
    '返回经过被解牌开关 K0 的实际带电路径');

  console.log(`\n回归结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
