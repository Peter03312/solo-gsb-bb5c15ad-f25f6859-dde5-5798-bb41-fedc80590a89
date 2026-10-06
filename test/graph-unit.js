'use strict';
// graph.js 纯算法单元测试(无需启动服务/数据库)。
// 覆盖: 精确判定不受枚举上限影响(数量/长度)、无启用电源、全部挂牌切断、含环图。
const assert = require('assert');
const {
  evaluateIsolation,
  findLiveWitness,
  MAX_PATHS,
  MAX_PATH_LEN
} = require('../src/graph');

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log('  ✔', name);
}

// 构造图: nodes=[{id,kind,enabled,tagged}], edges=[[from,to],...]
function build(nodes, pairs) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  const edges = pairs.map(([from_node, to_node], i) => {
    // 与 server.js loadGraph 的 SQL 别名保持一致: graph.js 按 e.to/e.from 遍历
    const e = { id: i + 1, from: from_node, to: to_node, from_node, to_node };
    if (!outAdj.has(from_node)) outAdj.set(from_node, []);
    outAdj.get(from_node).push(e);
    return e;
  });
  return { nodes, edges, nodeById, outAdj };
}
const S = (id, enabled = true) => ({ id, kind: 'source', enabled, tagged: false });
const K = (id, tagged = false) => ({ id, kind: 'switch', enabled: true, open_pos: true, tagged });
const D = (id) => ({ id, kind: 'device', enabled: true, tagged: false });

// 1. 无启用电源(唯一电源停用) -> 隔离, 可申请
check('无启用电源视为隔离', () => {
  const g = build([S(1, false), K(2), D(3)], [[1, 2], [2, 3]]);
  const r = evaluateIsolation(g, 3);
  assert.strictEqual(r.isolated, true);
  assert.strictEqual(r.livePaths.length, 0);
  assert.strictEqual(findLiveWitness(g, 3), null);
});

// 2. 所有通路均被挂牌切断 -> 隔离
check('所有通路被挂牌切断视为隔离', () => {
  const g = build(
    [S(1), S(2), K(3, true), K(4, true), K(5), D(6)],
    [[1, 3], [2, 4], [3, 5], [4, 5], [5, 6]]
  );
  const r = evaluateIsolation(g, 6);
  assert.strictEqual(r.isolated, true);
  assert.ok(r.blockedPaths.length >= 2);
});

// 3. 数量上限: 200 条挂牌支路 + 1 条直达(等长星形) -> 未隔离, totalTruncated
check('数量触顶不漏判第 201 条直达支路', () => {
  const nodes = [S(1), K(2), D(3)];
  const pairs = [[1, 2], [2, 3]]; // 直达支路
  for (let i = 0; i < MAX_PATHS; i++) {
    const id = 100 + i;
    nodes.push(K(id, true));
    pairs.push([2, id], [id, 3]);
  }
  const g = build(nodes, pairs);
  const r = evaluateIsolation(g, 3);
  assert.strictEqual(r.isolated, false);
  assert.strictEqual(r.totalTruncated, true);
  assert.ok(r.livePaths.length >= 1);
  assert.ok(r.livePaths.some((p) => p.nodes[0] === 1 && p.nodes[p.nodes.length - 1] === 3));
});

// 4. 长度上限: 长度 70 的链(无挂牌)末端为设备, 枚举在 64 处放弃 -> 未隔离, lengthTruncated
check('长度触顶不把未知当已隔离', () => {
  const nodes = [S(1)];
  const pairs = [];
  let prev = 1;
  for (let i = 2; i <= 69; i++) { nodes.push(K(i)); pairs.push([prev, i]); prev = i; }
  nodes.push(D(70));
  pairs.push([69, 70]);
  const g = build(nodes, pairs);
  assert.ok(nodes.length - 1 > MAX_PATH_LEN, '前置: 链长超过 MAX_PATH_LEN');
  const r = evaluateIsolation(g, 70);
  assert.strictEqual(r.isolated, false, 'BFS 精确判定仍发现带电路径');
  assert.strictEqual(r.lengthTruncated, true);
  assert.ok(r.livePaths.length >= 1, '至少补入一条实际带电路径');
  assert.strictEqual(r.livePaths[0].nodes[r.livePaths[0].nodes.length - 1], 70);
});

// 5. 含环图: 电源-开关成环, 设备在挂牌点之后(挂牌切断) -> 隔离且不卡死
check('挂牌点之后的环中设备被隔离且搜索终止', () => {
  const g = build(
    [S(1), K(2, true), K(3), K(4), D(5)],
    [[1, 2], [2, 3], [3, 4], [4, 3], [3, 5]]
  );
  const r = evaluateIsolation(g, 5);
  assert.strictEqual(r.isolated, true);
});

// 6. 含环图但环提供绕挂牌点的带电通路 -> 未隔离
check('环中绕过挂牌点的带电通路被发现', () => {
  // 1源 -> 2(挂牌) -> 5设备; 另有 1 -> 3 -> 4 -> 5 且 3<->4 成环
  const g = build(
    [S(1), K(2, true), K(3), K(4), D(5)],
    [[1, 2], [2, 5], [1, 3], [3, 4], [4, 3], [4, 5]]
  );
  const r = evaluateIsolation(g, 5);
  assert.strictEqual(r.isolated, false);
  assert.ok(r.livePaths.some((p) => p.nodes.includes(3) && p.nodes.includes(4)));
});

// 7. witness 不经过任何挂牌开关
check('witness 路径不含挂牌节点', () => {
  const g = build(
    [S(1), K(2, true), K(3), D(4)],
    [[1, 2], [2, 4], [1, 3], [3, 4]]
  );
  const w = findLiveWitness(g, 4);
  assert.ok(w);
  assert.deepStrictEqual(w.nodes, [1, 3, 4]);
  assert.ok(w.edges.length === 2);
});

console.log(`\n单元测试结果: ${pass} 项全部通过`);
