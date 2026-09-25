/**
 * SiliconFlow ASR 单元测试（2026-09-25，39d W3-5「语音转写」那一格）。
 *
 * 这个 provider 在迁入公共任务基础之前**一条用例都没有**：重试几次、哪些错误算瞬时、
 * 超时归哪一类，全都只存在于一段没被任何测试跑过的代码里。这里的用例按
 * 「调用次数」和「错误码」两件事来钉——那正是这次迁移改变的两侧，
 * 而 provider 合同（multipart 组装、净化、四个错误码）一条不许变。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asrAudioSha256,
  asrIdempotencyKey,
  siliconFlowTranscribe,
  SiliconFlowAsrError,
  type AsrRequester,
} from "./siliconflow-asr.ts";

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const SCOPE = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal | undefined;
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      if (typeof body === "string") throw new SyntaxError("响应不是合法 JSON");
      return body;
    },
  } as unknown as Response;
}

/** 一个"按脚本逐次应答"的出口替身，并记下每一次请求。 */
function scriptedRequest(script: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl: AsrRequester = async (url, init) => {
    const call: Call = {
      url,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    const next = script[calls.length - 1];
    if (!next) throw new Error(`ASR 请求次数超出了脚本（第 ${calls.length} 次）`);
    return next(call);
  };
  return { calls, impl };
}

function transcribe(requester: AsrRequester, extra: Record<string, unknown> = {}) {
  return siliconFlowTranscribe(AUDIO, "take-1.wav", {
    apiKey: "test-key",
    requester,
    scope: SCOPE,
    currentActiveTransaction: () => undefined,
    ...extra,
  });
}

/** `assert.rejects` 只说"抛了"，这里要拿到那个错误看它的 code。 */
async function asrError(run: () => Promise<unknown>): Promise<SiliconFlowAsrError> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown instanceof SiliconFlowAsrError,
    `期望 SiliconFlowAsrError（fail closed 的出口），实际是 ${String(thrown)}`,
  );
  return thrown;
}

test("正常一段录音：一次请求、返回去空白后的 transcript", async () => {
  const { calls, impl } = scriptedRequest([() => response(200, { text: "  索引的选择性  " })]);
  const result = await transcribe(impl);
  assert.equal(result.text, "索引的选择性");
  assert.equal(result.rawText, "索引的选择性");
  assert.equal(calls.length, 1, "成功路径不许多花一次请求");
});

test("瞬时故障自动再来一次：503 后 200 仍然拿到转写（改之前这里直接 502）", async () => {
  const { calls, impl } = scriptedRequest([
    () => response(503, { message: "overloaded" }),
    () => response(200, { text: "测试语音。" }),
  ]);
  const result = await transcribe(impl);
  assert.equal(result.text, "测试语音。");
  assert.equal(calls.length, 2);
});

test("一直 5xx：恰好两次请求后 fail closed，错误码与状态仍是 UPSTREAM_ERROR", async () => {
  const { calls, impl } = scriptedRequest([
    () => response(500, { message: "boom" }),
    () => response(502, { message: "bad gateway" }),
    () => response(200, { text: "不该走到这里" }),
  ]);
  const err = await asrError(() => transcribe(impl));
  assert.equal(err.code, "UPSTREAM_ERROR");
  assert.equal(err.status, 502, "内部记录要留最后一次上游状态（路由不透出 message）");
  assert.equal(calls.length, 2, "预算是 1 次 + 1 次自动重试，不是无限重试");
});

test("非瞬时 4xx 不重试：401 只发一次请求", async () => {
  const { calls, impl } = scriptedRequest([
    () => response(401, { message: "invalid api key" }),
    () => response(200, { text: "不该走到这里" }),
  ]);
  const err = await asrError(() => transcribe(impl));
  assert.equal(err.code, "UPSTREAM_ERROR");
  assert.equal(calls.length, 1, "鉴权不对的请求，重试只是让用户多等一遍");
});

test("空 transcript 算形状问题：有一次修复机会，仍空就 EMPTY_TRANSCRIPT", async () => {
  const { calls, impl } = scriptedRequest([
    () => response(200, { text: "   " }),
    () => response(200, { text: "" }),
  ]);
  const err = await asrError(() => transcribe(impl));
  assert.equal(err.code, "EMPTY_TRANSCRIPT");
  assert.equal(calls.length, 2);
});

test("200 但响应不是 JSON：归成形状问题，不再漏成没包装的异常", async () => {
  // 两条脚本：形状问题在 kernel 那条规则里也有一次修复额度（与 critic 同一形状），
  // 只给一条会让第二次请求撞上替身自己抛的错，测到的就不是产品的分类。
  const malformed = () => response(200, "<html>502 Bad Gateway</html>");
  const { calls, impl } = scriptedRequest([malformed, malformed]);
  const err = await asrError(() => transcribe(impl));
  assert.equal(err.code, "EMPTY_TRANSCRIPT");
  assert.equal(calls.length, 2);
});

test("在活动事务里调用 ⇒ 边界当场拒绝，一次请求都不发", async () => {
  let sent = 0;
  const { impl } = scriptedRequest([() => { sent += 1; return response(200, { text: "x" }); }]);
  await assert.rejects(
    () => transcribe(impl, { currentActiveTransaction: () => ({ context: {}, transaction: {}, open: true }) }),
    /外部调用被拒/,
  );
  assert.equal(sent, 0, "边界拒了却还是把请求发出去了");
});

test("单步超时由内核的 signal 管：请求带着可取消信号出去，超时后 fail closed", async () => {
  const hang: (call: Call) => Promise<Response> = (call) =>
    new Promise((_resolve, reject) => {
      call.signal?.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const { calls, impl } = scriptedRequest([hang, hang, () => response(200, { text: "不该走到这里" })]);
  const err = await asrError(() => transcribe(impl, { timeoutMs: 40 }));
  assert.equal(err.code, "NETWORK_ERROR");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.signal, "请求没拿到取消信号 ⇒ 这一步其实没人管它的时长");
  }
});

test("幂等键只由音频字节决定：同一段录音认得出同一件事，换一段就是另一件事", () => {
  const same = asrIdempotencyKey(asrAudioSha256(AUDIO));
  assert.equal(same, asrIdempotencyKey(asrAudioSha256(Uint8Array.from(AUDIO))));
  assert.notEqual(same, asrIdempotencyKey(asrAudioSha256(new Uint8Array([1, 2, 3]))));
  assert.match(same, /^voice-transcribe:[0-9a-f]{64}$/);
});

test("multipart：文件名净化后不许注入边界，音频字节原样送达", async () => {
  const { calls, impl } = scriptedRequest([() => response(200, { text: "好" })]);
  await siliconFlowTranscribe(AUDIO, 'x"\r\n--SiliconFlowAsrBoundary evil.wav', {
    apiKey: "test-key",
    requester: impl,
    scope: SCOPE,
    currentActiveTransaction: () => undefined,
  });
  const bodyText = Buffer.from(calls[0].body).toString("latin1");
  const boundary = (calls[0].headers["Content-Type"] ?? "").replace("multipart/form-data; boundary=", "");
  // 判据是**请求体的形状**：两段、每段一行 Content-Disposition、文件名里不许有引号或换行。
  // 只数边界出现次数是瞎的——注入串 `x"\r\n--…` 自己会关掉 filename 的引号，段数看着还对。
  const shape = new RegExp(
    `^--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n` +
      "FunAudioLLM/SenseVoiceSmall\r\n" +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="[^"\r\n]*"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  assert.ok(
    shape.test(bodyText),
    `请求体不是"两段、头部各一行"的形状（文件名注入把结构切开了）：${JSON.stringify(bodyText.slice(0, 260))}`,
  );
  assert.ok(bodyText.endsWith(`\r\n--${boundary}--\r\n`), "结束标记缺失");
  assert.ok(Buffer.from(calls[0].body).includes(Buffer.from(AUDIO)), "音频字节没原样进入请求体");
  assert.match(calls[0].headers["Content-Type"] ?? "", /^multipart\/form-data; boundary=----SiliconFlowAsrBoundary/);
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
});

test("默认出口不拒非公网地址：代理／合成 DNS 解析下语音仍然发得出去（那是活路径）", async () => {
  // 这条钉的是 2026-09-25 撤掉公网地址闸那个决定。撤的理由是实测：本机
  // `api.siliconflow.cn` 解析进 198.18.0.x，那道闸把整个请求拒掉，而它今天
  // 挡不住任何真实威胁（baseUrl 只能由代码给）。重新加闸必须先满足源文件里
  // 写明的两个前提；谁加了闸，这条就会红——那是故意的，逼人来改判据。
  let sent = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    sent += 1;
    return response(200, { text: "索引的选择性" });
  }) as unknown as typeof fetch;
  try {
    const result = await siliconFlowTranscribe(AUDIO, "take-1.wav", {
      apiKey: "test-key",
      baseUrl: "https://198.18.0.38/v1/audio/transcriptions",
      scope: SCOPE,
      currentActiveTransaction: () => undefined,
    });
    assert.equal(sent, 1, "默认出口把一个能连通的地址拒掉了（语音识别会整体失效）");
    assert.equal(result.text, "索引的选择性");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("未配置 SILICONFLOW_API_KEY ⇒ 仍然 MISSING_API_KEY，且不发请求", async () => {
  const saved = process.env.SILICONFLOW_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  try {
    let sent = 0;
    const { impl } = scriptedRequest([() => { sent += 1; return response(200, { text: "x" }); }]);
    const err = await asrError(() =>
      siliconFlowTranscribe(AUDIO, "a.wav", {
        requester: impl, scope: SCOPE, currentActiveTransaction: () => undefined,
      }),
    );
    assert.equal(err.code, "MISSING_API_KEY");
    assert.equal(sent, 0);
  } finally {
    if (saved !== undefined) process.env.SILICONFLOW_API_KEY = saved;
  }
});
