/**
 * Zod → JSON Schema 转换器
 *
 * 将 Zod schema 转换为 provider 兼容的 JSON Schema。
 * 作为唯一真相源：tool-registry 只维护 Zod schema，JSON Schema 由本模块自动生成。
 *
 * 支持的 Zod 类型：
 * - z.object (含 .strict() / .passthrough() / .optional() / .default())
 * - z.string (含 min/max/maxLength/enum)
 * - z.number (含 min/max/int)
 * - z.boolean
 * - z.array (含 min/max items)
 * - z.enum
 * - z.literal
 * - z.union / z.optional
 * - z.null / z.nullable
 * - z.record
 * - z.any / z.unknown
 * - z.effects (z.refine / z.transform)
 */

import type { ZodTypeAny } from "zod";

/**
 * 将 Zod schema 转换为 JSON Schema。
 *
 * 此函数递归遍历 Zod schema 树，生成对应的 JSON Schema 定义。
 * 所有 object 类型默认 additionalProperties: false（对应 .strict()）。
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return convertZod(schema);
}

interface ZodDef {
  typeName?: string;
  shape?: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>;
  checks?: Array<Record<string, unknown>>;
  type?: ZodTypeAny;
  values?: string[];
  value?: unknown;
  options?: ZodTypeAny[];
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  left?: ZodTypeAny;
  right?: ZodTypeAny;
  valueType?: ZodTypeAny;
  defaultValue?: unknown;
  // ZodArray v3 fields
  minLength?: { value: number; message?: string } | null;
  maxLength?: { value: number; message?: string } | null;
  exactLength?: { value: number; message?: string } | null;
}

function getDef(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function convertZod(schema: ZodTypeAny): Record<string, unknown> {
  const def = getDef(schema);
  const typeName = def.typeName;

  switch (typeName) {
    case "ZodObject": {
      // Zod v3: shape is a function () => Record<string, ZodTypeAny>
      const shapeRaw = def.shape;
      const shape = typeof shapeRaw === "function"
        ? (shapeRaw as () => Record<string, ZodTypeAny>)()
        : (shapeRaw as Record<string, ZodTypeAny>) ?? {};

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, valueSchema] of Object.entries(shape)) {
        properties[key] = convertZod(valueSchema);
        // 检查是否是 optional/default
        const valueDef = getDef(valueSchema);
        const isOptional =
          valueDef.typeName === "ZodOptional" ||
          valueDef.typeName === "ZodDefault";
        if (!isOptional) {
          required.push(key);
        }
      }

      const result: Record<string, unknown> = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) {
        result.required = required;
      }
      return result;
    }

    case "ZodString": {
      const checks = def.checks ?? [];
      const result: Record<string, unknown> = { type: "string" };
      for (const check of checks) {
        if (check.kind === "min") result.minLength = check.value;
        if (check.kind === "max") result.maxLength = check.value;
        if (check.kind === "length") {
          result.minLength = check.value;
          result.maxLength = check.value;
        }
      }
      return result;
    }

    case "ZodNumber": {
      const checks = def.checks ?? [];
      const result: Record<string, unknown> = { type: "number" };
      for (const check of checks) {
        if (check.kind === "min") result.minimum = check.value;
        if (check.kind === "max") result.maximum = check.value;
        if (check.kind === "int") result.type = "integer";
      }
      return result;
    }

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodArray": {
      const result: Record<string, unknown> = {
        type: "array",
        items: convertZod(def.type!),
      };
      // Zod v3: ZodArray uses minLength/maxLength/exactLength in _def, not checks
      if (def.exactLength) {
        result.minItems = def.exactLength.value;
        result.maxItems = def.exactLength.value;
      } else {
        if (def.minLength) result.minItems = def.minLength.value;
        if (def.maxLength) result.maxItems = def.maxLength.value;
      }
      // Fallback: also check checks array (some Zod versions use this)
      const checks = def.checks ?? [];
      if (result.minItems === undefined) {
        const minCheck = checks.find((c) => c.kind === "min")?.value;
        if (minCheck !== undefined) result.minItems = minCheck;
      }
      if (result.maxItems === undefined) {
        const maxCheck = checks.find((c) => c.kind === "max")?.value;
        if (maxCheck !== undefined) result.maxItems = maxCheck;
      }
      return result;
    }

    case "ZodEnum":
    case "ZodNativeEnum": {
      return { type: "string", enum: def.values ?? [] };
    }

    case "ZodLiteral":
      return {
        type: typeof def.value === "number" ? "number" : "string",
        const: def.value,
      };

    case "ZodUnion": {
      const options = def.options ?? [];
      return { anyOf: options.map((o) => convertZod(o)) };
    }

    case "ZodNull":
      return { type: "null" };

    case "ZodNullable": {
      const inner = convertZod(def.innerType!);
      return { anyOf: [inner, { type: "null" }] };
    }

    case "ZodRecord": {
      return {
        type: "object",
        additionalProperties: convertZod(def.valueType!),
      };
    }

    case "ZodAny":
    case "ZodUnknown":
      return {};

    case "ZodDefault": {
      return convertZod(def.innerType!);
    }

    case "ZodOptional": {
      return convertZod(def.innerType!);
    }

    case "ZodEffects": {
      // z.refine / z.transform — 递归到 inner schema
      return convertZod(def.schema!);
    }

    case "ZodIntersection": {
      const left = convertZod(def.left!);
      const right = convertZod(def.right!);
      return {
        type: "object",
        properties: {
          ...((left.properties as Record<string, unknown>) ?? {}),
          ...((right.properties as Record<string, unknown>) ?? {}),
        },
        required: [
          ...((left.required as string[]) ?? []),
          ...((right.required as string[]) ?? []),
        ].filter((v, i, arr) => arr.indexOf(v) === i),
        additionalProperties: false,
      };
    }

    default:
      // Fallback: 返回空 schema（允许任意值）
      return {};
  }
}
