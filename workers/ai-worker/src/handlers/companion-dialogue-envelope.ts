/**
 * 流式 JSON 信封解码（2026-09-19）。
 *
 * 背景：整段取回路径用 `response_format: json_object`，模型因此会写**完整、独立**
 * 的回复（`{"reply": "嘿嘿，我在呢。…"}`）。流式改造一度把它换成纯文本模式，
 * 实机复现出模型改成**续写上一条助手消息**——回复以"，/的呀。"开头、缺主语：
 *
 *   文本模式：  ，我在呢。看你这么开心，我也跟着乐了。
 *   json_object：嘿嘿，我在呢。看你笑得这么开心，是有什么好事吗？
 *
 * 所以流式必须保持 JSON 模式，代价是流里带着 JSON 语法——这个解码器把它即时剥掉：
 * 找到正文键的开引号后逐字符解转义，遇到收尾引号即完成；识别不出形状就报
 * `unrecognized`，由调用方退回"整段取回 + 事后切片"的既有路径。
 */

/** 与 unwrapCompanionJsonEnvelope 同源的正文键（数组类键如 blocks 不在流式支持内）。 */
const ENVELOPE_STREAM_KEYS = ["response", "text", "content", "message", "reply", "answer"] as const;

/**
 * 只在**信封头**（对象/数组开头的第一个键）匹配正文键。
 *
 * 不能在后文任意位置匹配：实机出现过 `{\n "content": "…"…}` 这种多字段信封，
 * 后文还可能再出现别的正文键，而整段 unwrap 是按**优先级**取键的——两处选到
 * 不同的键就会让"流式下发的内容"和"落库的正文"对不上（安全网会判失败）。
 * 收紧到信封头之后，解码出的文本就是唯一事实来源（见 runStreamingAgentStep
 * 把解码结果当作返回内容），这类分叉从结构上消失。
 */
const ENVELOPE_KEY_PATTERN = new RegExp(`^\\s*\\[?\\s*\\{\\s*"(${ENVELOPE_STREAM_KEYS.join("|")})"\\s*:\\s*"`);

/** 信封头（键 + 冒号 + 开引号）的最大长度：超出说明不是我们认识的形状。 */
const ENVELOPE_HEAD_MAX_CHARS = 512;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

export type CompanionEnvelopeChunk =
  | { readonly kind: "text"; readonly text: string }
  /** 形状不认识：调用方应停止流式下发（整段兜底会补上内容）。 */
  | { readonly kind: "unrecognized" }
  /** 正文已经收尾（遇到收尾引号），后续输入一律忽略。 */
  | { readonly kind: "completed" };

export interface CompanionEnvelopeDecoder {
  push(delta: string): CompanionEnvelopeChunk[];
  /** 已解码出的正文（累积；形状不认识时为空串）。 */
  text(): string;
}

type DecoderMode = "seeking" | "decoding" | "completed" | "unrecognized";

/** 解析一个完整的转义序列（`\n` / `\"` / `\uXXXX`）；不完整或非法返回 null。 */
function resolveEscape(sequence: string): string | null {
  if (sequence.startsWith("\\u")) {
    if (sequence.length < 6) return null;
    // 必须是四位十六进制：parseInt 遇到 "12zz" 会停在 12 并"成功"，
    // 那样会把非法转义解成一个控制字符，而不是按字面量保留。
    const hex = sequence.slice(2, 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }
  if (sequence.length < 2) return null;
  return SIMPLE_ESCAPES[sequence[1]] ?? null;
}

/**
 * 创建一个增量解码器。同一实例喂完整轮模型增量；状态机只前进不回退。
 */
export function createCompanionEnvelopeDecoder(): CompanionEnvelopeDecoder {
  let mode: DecoderMode = "seeking";
  let head = "";
  /** 落单的反斜杠或半个 \uXXXX：留到下一段增量再解。 */
  let pendingEscape = "";
  let decoded = "";

  function decode(rest: string): CompanionEnvelopeChunk[] {
    const out: CompanionEnvelopeChunk[] = [];
    let text = "";
    let index = 0;
    const flushText = (): void => {
      if (text.length === 0) return;
      decoded += text;
      out.push({ kind: "text", text });
      text = "";
    };

    while (index < rest.length) {
      if (pendingEscape.length > 0) {
        const need = pendingEscape.startsWith("\\u") ? 6 : 2;
        const take = Math.min(need - pendingEscape.length, rest.length - index);
        pendingEscape += rest.slice(index, index + take);
        index += take;
        if (pendingEscape.length < need) {
          flushText();
          return out;
        }
        text += resolveEscape(pendingEscape) ?? pendingEscape;
        pendingEscape = "";
        continue;
      }

      const char = rest[index];
      if (char === "\\") {
        const next = rest[index + 1];
        if (next === undefined) {
          pendingEscape = "\\";
          break;
        }
        if (next === "u") {
          if (index + 6 > rest.length) {
            pendingEscape = rest.slice(index);
            break;
          }
          text += resolveEscape(rest.slice(index, index + 6)) ?? rest.slice(index, index + 6);
          index += 6;
          continue;
        }
        text += SIMPLE_ESCAPES[next] ?? next;
        index += 2;
        continue;
      }
      if (char === '"') {
        flushText();
        mode = "completed";
        out.push({ kind: "completed" });
        return out;
      }
      text += char;
      index += 1;
    }

    flushText();
    return out;
  }

  return {
    push(delta: string): CompanionEnvelopeChunk[] {
      if (mode === "completed" || mode === "unrecognized") return [];
      if (delta.length === 0) return [];
      if (mode === "decoding") return decode(delta);

      head += delta;
      const match = ENVELOPE_KEY_PATTERN.exec(head);
      if (!match) {
        if (head.length > ENVELOPE_HEAD_MAX_CHARS) {
          mode = "unrecognized";
          return [{ kind: "unrecognized" }];
        }
        return [];
      }
      const rest = head.slice(match.index + match[0].length);
      head = "";
      mode = "decoding";
      return decode(rest);
    },

    text(): string {
      return decoded;
    },
  };
}
