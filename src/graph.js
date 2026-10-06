'use strict';

// 有向供电图与隔离判定逻辑。
// 供电方向: edges from_node -> to_node。
// 只有 enabled=1 的电源为有效电源; 经过 tagged=1 的开关的路径视为已被切断。
// 开关物理分合位(open_pos)是现场状态, 挂牌要求先分闸, 但隔离只认挂牌。
//
// 安全原则(2026-10 修复):
//   隔离判定必须是精确的——不存在任何“从启用电源出发、不经过挂牌开关即可到达
//   设备”的通路。供电路径可能组合爆炸, 因此判定本身使用线性时间的可达性搜索
//   (BFS, 挂牌开关即屏障), 不受路径数量/长度上限影响, 数量上限只用于诊断展示。
//   任何枚举截断都只能当作“未知”, 绝不能当作“已隔离”: 拒绝操作时另用 BFS 反推
//   至少一条实际带电路径(witness)随错误返回。

const MAX_PATHS = 200;  // 诊断展示用: 枚举路径条数上限, 防止含环图上组合爆炸
const MAX_PATH_LEN = 64; // 诊断展示用: 单条路径节点数上限

/**
 * 精确判定: 是否存在从任一启用电源出发、不经过挂牌开关到达 target 的通路。
 * BFS 在线性时间内完成, 挂牌开关即不可跨越的屏障, 不枚举全部路径,
 * 因而不受 MAX_PATHS / MAX_PATH_LEN 限制, 不存在“枚举触顶漏判”。
 *
 * @returns 带电路径(节点 id / 边 id 链, 不含挂牌节点), 无通路时返回 null。
 *   无启用电源时同样返回 null(无电源即隔离)。
 */
function findLiveWitness(graph, targetId) {
  const sources = graph.nodes
    .filter((n) => n.kind === 'source' && n.enabled)
    .map((n) => n.id);

  const prev = new Map(); // nodeId -> { viaEdge, from }
  const queue = [];
  for (const src of sources) {
    if (prev.has(src)) continue;
    prev.set(src, null);
    queue.push(src);
  }

  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === targetId) {
      const nodes = [];
      const edges = [];
      for (let id = cur; id !== null;) {
        nodes.push(id);
        const p = prev.get(id);
        if (!p) break;
        edges.push(p.viaEdge);
        id = p.from;
      }
      nodes.reverse();
      edges.reverse();
      return { nodes, edges, blockedByTag: false, tagged: [] };
    }
    const node = graph.nodeById.get(cur);
    // 到达挂牌开关: 屏障, 不再向下游走(起点就是挂牌开关的情况同理)
    if (node && node.kind === 'switch' && node.tagged) continue;
    for (const e of graph.outAdj.get(cur) || []) {
      if (!prev.has(e.to)) {
        prev.set(e.to, { viaEdge: e.id, from: cur });
        queue.push(e.to);
      }
    }
  }
  return null;
}

/**
 * 有界 DFS 枚举路径, 仅供诊断展示(API / 快照 / 界面高亮)。
 * 遇到挂牌开关的分支记为“被挂牌切断”路径并终止; 到达设备记为“未切断”路径。
 * 上限只影响返回内容的多少, 绝不影响隔离判定:
 *  - totalTruncated: 全部路径(未切断+被切断)枚举达到 MAX_PATHS;
 *  - lengthTruncated: 存在长度超过 MAX_PATH_LEN 的分支被省略。
 * @returns {{ livePaths:Array, blockedPaths:Array,
 *            totalTruncated:boolean, lengthTruncated:boolean }}
 */
function enumeratePaths(graph, targetId) {
  const enabledSources = graph.nodes
    .filter((n) => n.kind === 'source' && n.enabled)
    .map((n) => n.id);

  const livePaths = [];
  const blockedPaths = [];
  const state = { totalTruncated: false, lengthTruncated: false };

  const pushPath = (nodePath, edgePath, blockedByTag) => {
    const path = {
      nodes: nodePath.slice(),
      edges: edgePath.slice(),
      blockedByTag,
      tagged: blockedByTag ? [nodePath[nodePath.length - 1]] : []
    };
    (blockedByTag ? blockedPaths : livePaths).push(path);
    if (livePaths.length + blockedPaths.length >= MAX_PATHS) {
      state.totalTruncated = true;
      return false; // 触顶: 停止整棵搜索
    }
    return true;
  };

  for (const src of enabledSources) {
    if (state.totalTruncated) break;
    dfs(graph, src, targetId, new Set(), [src], new Set(), [],
      livePaths, blockedPaths, state, pushPath);
  }
  return { livePaths, blockedPaths, ...state };
}

function dfs(graph, cur, target, nodeSeen, nodePath, edgeSeen, edgePath,
           livePaths, blockedPaths, state, pushPath) {
  // 路径过长: 标记后放弃该分支(诊断展示限制, 不代表该分支无电)
  if (nodePath.length > MAX_PATH_LEN) {
    state.lengthTruncated = true;
    return;
  }
  if (cur === target) {
    if (!pushPath(nodePath, edgePath, false)) state.totalTruncated = true;
    return;
  }
  // 已挂牌开关: 通路在此被切断, 不再向下游走
  const curNode = graph.nodeById.get(cur);
  if (curNode && curNode.kind === 'switch' && curNode.tagged) {
    if (!pushPath(nodePath, edgePath, true)) state.totalTruncated = true;
    return;
  }

  const outs = graph.outAdj.get(cur) || [];
  for (const e of outs) {
    if (state.totalTruncated) return;
    // 防止环导致的无限递归: 节点与边都不重复
    if (nodeSeen.has(e.to) || edgeSeen.has(e.id)) continue;
    nodeSeen.add(e.to);
    edgeSeen.add(e.id);
    nodePath.push(e.to);
    edgePath.push(e.id);
    dfs(graph, e.to, target, nodeSeen, nodePath, edgeSeen, edgePath,
      livePaths, blockedPaths, state, pushPath);
    edgePath.pop();
    nodePath.pop();
    edgeSeen.delete(e.id);
    nodeSeen.delete(e.to);
  }
}

/**
 * 判定设备是否满足隔离条件: 不存在任何从启用电源到设备的未切断路径。
 * isolated 由精确可达性搜索给出(无上限); livePaths/blockedPaths 为有界诊断枚举,
 * 截断时 truncated=true, 调用方不得把截断解释为已隔离。
 * @returns {{ isolated:boolean, livePaths:Array, blockedPaths:Array,
 *            truncated:boolean, totalTruncated:boolean, lengthTruncated:boolean }}
 */
function evaluateIsolation(graph, deviceId) {
  const witness = findLiveWitness(graph, deviceId);
  const enumeration = enumeratePaths(graph, deviceId);
  const livePaths = enumeration.livePaths;

  // 精确判定有带电通路、但有界枚举因截断把它漏掉时: 补入一条实际带电路径,
  // 保证任何拒绝判定都至少返回一条可定位的来电路径。
  if (witness && !livePaths.some((p) => samePath(p, witness))) {
    livePaths.push(witness);
  }

  return {
    isolated: witness === null,
    livePaths,
    blockedPaths: enumeration.blockedPaths,
    truncated: enumeration.totalTruncated || enumeration.lengthTruncated,
    totalTruncated: enumeration.totalTruncated,
    lengthTruncated: enumeration.lengthTruncated
  };
}

function samePath(a, b) {
  return a.nodes.length === b.nodes.length && a.nodes.every((id, i) => id === b.nodes[i]);
}

/**
 * 对所有有效检修许可重新校验隔离条件(精确判定)。
 * @returns 不满足隔离的许可数组 [{ permit, livePaths, truncated, ... }]
 */
function validateActivePermits(graph, permits) {
  const violations = [];
  for (const p of permits) {
    const r = evaluateIsolation(graph, p.device_id);
    if (!r.isolated) {
      violations.push({
        permit: p,
        livePaths: r.livePaths,
        truncated: r.truncated,
        totalTruncated: r.totalTruncated,
        lengthTruncated: r.lengthTruncated
      });
    }
  }
  return violations;
}

function serializePath(graph, path) {
  return {
    nodes: path.nodes.map((id) => {
      const n = graph.nodeById.get(id);
      return { id, kind: n.kind, name: n.name, tagged: !!n.tagged };
    }),
    edges: path.edges,
    blockedByTag: !!path.blockedByTag
  };
}

module.exports = {
  findLiveWitness,
  enumeratePaths,
  evaluateIsolation,
  validateActivePermits,
  serializePath,
  MAX_PATHS,
  MAX_PATH_LEN
};
