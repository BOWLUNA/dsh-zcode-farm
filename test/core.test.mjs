/**
 * core.test.js —— 纯函数测试。不碰网络、不依赖 DSH 宿主。
 *   node --test test/
 *
 * 其中几条用例的期望值直接取自本机实测那一刻的真实读数
 * （5 台 5090 各剩 0.5–0.9 GB 且都在跑视频工作流、一台 Blackwell 空着 99.4 GB），
 * 用来钉住「选实例」这个内核不会被改坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY,
  scoreInstance,
  scoreAll,
  pickBest,
  describeRunningJob,
} from '../src/farm.js';
import { buildTxt2Img, collectOutputs, outputViewUrl } from '../src/workflow.js';

const POLICY = { ...DEFAULT_POLICY, needVramGb: 8, maxQueueDepth: 3, queueWeight: 1000 };

function snap(over = {}) {
  return {
    id: 'x',
    baseUrl: 'http://127.0.0.1:1',
    reachable: true,
    error: null,
    gpu: 'RTX 5090',
    vramTotalGb: 33.7,
    vramFreeGb: 32.9,
    queueRunning: 0,
    queuePending: 0,
    running: [],
    ...over,
  };
}

test('不可达的实例一律不合格', () => {
  const r = scoreInstance(snap({ reachable: false, error: 'timeout >3000ms' }), POLICY);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /不可达/);
});

test('显存不足被挡下', () => {
  const r = scoreInstance(snap({ vramFreeGb: 4.8 }), POLICY);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /显存/);
});

test('队列过深被挡下', () => {
  const r = scoreInstance(snap({ queueRunning: 2, queuePending: 2 }), POLICY);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /队列/);
});

test('队列空 + 显存足 → 合格，且评分等于空闲显存', () => {
  const r = scoreInstance(snap({ vramFreeGb: 99.4, gpu: 'RTX PRO 6000' }), POLICY);
  assert.equal(r.eligible, true);
  assert.equal(r.score, 99.4);
  assert.match(r.reason, /队列空/);
});

test('队列权重让「空队列的小卡」赢过「排队的大卡」', () => {
  const idle = scoreInstance(snap({ id: 'idle', vramFreeGb: 32.9 }), POLICY);
  const busy = scoreInstance(snap({ id: 'busy', vramFreeGb: 99.4, queueRunning: 1 }), POLICY);
  assert.ok(idle.score > busy.score, `期望 idle(${idle.score}) > busy(${busy.score})`);
});

test('全部不合格时 pickBest 返回 null（复现实测：5 台 5090 只剩 0.5–0.9 GB）', () => {
  const scored = scoreAll(
    [
      snap({ id: 'gpu-18100', vramFreeGb: 0.8, queueRunning: 1 }),
      snap({ id: 'gpu-18300', vramFreeGb: 0.8, queueRunning: 1 }),
      snap({ id: 'gpu-18301', vramFreeGb: 0.9, queueRunning: 1 }),
      snap({ id: 'gpu-18302', vramFreeGb: 0.5, queueRunning: 1 }),
    ],
    POLICY,
  );
  assert.equal(pickBest(scored), null);
});

test('pickBest 挑到那台唯一空闲的 Blackwell', () => {
  const scored = scoreAll(
    [
      snap({ id: 'gpu-18100', vramFreeGb: 0.8, queueRunning: 1 }),
      snap({ id: 'gpu-18303', vramFreeGb: 99.4, vramTotalGb: 102, gpu: 'RTX PRO 6000 B', queueRunning: 0 }),
    ],
    POLICY,
  );
  assert.equal(pickBest(scored).snap.id, 'gpu-18303');
});

test('describeRunningJob 认出视频/音频工作流', () => {
  const entry = [1, 'id', { a: { class_type: 'WanVideoSampler' }, b: { class_type: 'VAEDecode' } }];
  assert.match(describeRunningJob(entry), /video\/audio/);
});

test('describeRunningJob 对普通图工作流给出 loader 线索', () => {
  const entry = [1, 'id', { a: { class_type: 'CheckpointLoaderSimple' }, b: { class_type: 'KSampler' } }];
  assert.equal(describeRunningJob(entry), 'image (CheckpointLoaderSimple)');
});

test('describeRunningJob 对畸形输入不炸', () => {
  assert.equal(describeRunningJob(null), 'unknown');
  assert.equal(describeRunningJob([1, 'id', 'not-an-object']), 'unknown');
});

test('buildTxt2Img 产出可直接提交的 API 图', () => {
  const wf = buildTxt2Img({ prompt: 'a red cat', checkpoint: 'sd3.5_large.safetensors' });
  assert.equal(Object.keys(wf).length, 7);
  assert.equal(wf['4'].inputs.ckpt_name, 'sd3.5_large.safetensors');
  assert.equal(wf['6'].inputs.text, 'a red cat');
  assert.deepEqual(wf['3'].inputs.model, ['4', 0]);
  assert.deepEqual(wf['8'].inputs.vae, ['4', 2]);
  assert.equal(wf['9'].class_type, 'SaveImage');
});

test('buildTxt2Img 缺 checkpoint 直接报错，不产出半成品图', () => {
  assert.throws(() => buildTxt2Img({ prompt: 'x' }), /checkpoint/);
});

test('collectOutputs 摊平 images 与 gifs', () => {
  const entry = {
    outputs: {
      9: { images: [{ filename: 'a.png', subfolder: 'sub', type: 'output' }] },
      12: { gifs: [{ filename: 'b.mp4' }] },
    },
  };
  const out = collectOutputs(entry);
  assert.equal(out.length, 2);
  assert.equal(out[0].filename, 'a.png');
  assert.equal(out[0].subfolder, 'sub');
  assert.equal(out[1].kind, 'gifs');
  assert.equal(out[1].type, 'output');
});

test('collectOutputs 对空/畸形输入返回空数组', () => {
  assert.deepEqual(collectOutputs(undefined), []);
  assert.deepEqual(collectOutputs({}), []);
  assert.deepEqual(collectOutputs({ outputs: { 1: { images: 'nope' } } }), []);
  assert.deepEqual(collectOutputs({ outputs: { 1: { images: [null] } } }), []);
});

test('outputViewUrl 拼出可访问的 /view 链接并去掉尾斜杠', () => {
  const url = outputViewUrl('http://127.0.0.1:18303/', {
    filename: 'a.png',
    subfolder: 'sub',
    type: 'output',
  });
  assert.equal(url, 'http://127.0.0.1:18303/view?filename=a.png&subfolder=sub&type=output');
});
