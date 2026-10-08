/**
 * Canonical 7K JSON, in C#.
 *
 * `01-kernel.md` section 7 is one of the three artifacts D48 publishes: a message's canonical JSON is
 * part of the contract, not a detail of whatever happens to be serialising it. Which means a provider
 * that emits types a serialiser cannot produce that encoding from has not finished the job — it has
 * produced something that *looks* like the contract and is not.
 *
 * Without this, the default `System.Text.Json` output is wrong in four ways at once, and only the first
 * is fixable by the consumer:
 *
 * - Property names are PascalCase, where the contract says the field's own name.
 * - A nominal value nests: `{"sku":{"value":"SKU-77"}}` rather than `{"sku":"SKU-77"}`.
 * - A `decimal(18,2)` writes `12.5`, where the contract says the string `"12.50"` — *never* a number,
 *   because a JSON number is a double and money must not round-trip through one.
 * - An enum writes its index, where the contract says the member name as declared.
 *
 * So the attributes and converters are generated from the model, which is the only place the declared
 * scale and the declared member spelling exist.
 *
 * **One divergence, deliberately.** The spec says an `int` may encode as a string where its declared
 * range can exceed ±(2^53 − 1). Nothing implements that — the JSON Schema projection types every `int`
 * as a number — so this does too, rather than becoming the only runtime with a third answer.
 */

import { intIsWide } from "@sevenk/core";
import type { Decl, EnumIr, FieldIr, TypeIr, ValueIr } from "@sevenk/core";
import { csharpType, namespaceOf, pascal, type TypeContext } from "./types.js";

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `    ${l}`));

const quote = (text: string): string => JSON.stringify(text);

const absolute = (decl: Decl, ctx: TypeContext): string =>
  `global::${namespaceOf(decl.id.pkg, ctx.root)}.${pascal(decl.id.name)}`;

/**
 * The hand-written half: converters whose behaviour comes from the kernel and not from a declaration.
 *
 * `JsonConverterAttribute` is subclassed for the decimal, because the scale is a per-field fact and an
 * attribute argument is the only way to carry one to a converter. That is the whole reason this is not
 * four static converters.
 */
export const JSON_SUPPORT: readonly string[] = [
  "/// <summary>",
  "/// A `decimal(p,s)`, as the string the contract says it is.",
  "/// </summary>",
  "/// <remarks>",
  "/// <para>",
  "/// Never a JSON number: that is a double, and money must not round-trip through one",
  "/// (`01-kernel.md` 7.1). Always written with exactly the declared number of fractional digits, so",
  "/// that `12.5` and `12.50` are the same value and the same bytes.",
  "/// </para>",
  "/// </remarks>",
  "[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]",
  "public sealed class SevenKDecimalAttribute : JsonConverterAttribute",
  "{",
  "    /// <param name=\"scale\">The declared scale: the `2` of `decimal(18,2)`.</param>",
  "    public SevenKDecimalAttribute(int scale) => Scale = scale;",
  "",
  "    /// <summary>The declared scale.</summary>",
  "    public int Scale { get; }",
  "",
  "    /// <inheritdoc />",
  "    public override JsonConverter CreateConverter(Type typeToConvert) =>",
  "        typeToConvert == typeof(decimal?)",
  "            ? new NullableConverter(Scale)",
  "            : new Converter(Scale);",
  "",
  "    private sealed class Converter : JsonConverter<decimal>",
  "    {",
  "        private readonly int scale;",
  "        public Converter(int scale) => this.scale = scale;",
  "",
  "        public override decimal Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>",
  "            Decimals.Read(ref reader);",
  "",
  "        public override void Write(Utf8JsonWriter writer, decimal value, JsonSerializerOptions options) =>",
  "            writer.WriteStringValue(Decimals.Text(value, scale));",
  "",
  "        // A map key is written as a property name, which takes a different call.",
  "        public override void WriteAsPropertyName(",
  "            Utf8JsonWriter writer, decimal value, JsonSerializerOptions options) =>",
  "            writer.WritePropertyName(Decimals.Text(value, scale));",
  "    }",
  "",
  "    private sealed class NullableConverter : JsonConverter<decimal?>",
  "    {",
  "        private readonly int scale;",
  "        public NullableConverter(int scale) => this.scale = scale;",
  "",
  "        public override decimal? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>",
  "            reader.TokenType == JsonTokenType.Null ? null : Decimals.Read(ref reader);",
  "",
  "        public override void Write(Utf8JsonWriter writer, decimal? value, JsonSerializerOptions options)",
  "        {",
  "            if (value is null) writer.WriteNullValue();",
  "            else writer.WriteStringValue(Decimals.Text(value.Value, scale));",
  "        }",
  "    }",
  "}",
  "",
  "/// <summary>Reading and writing a decimal the way the contract spells it.</summary>",
  "public static class Decimals",
  "{",
  "    /// <summary>Exactly `scale` fractional digits, and never in the ambient culture.</summary>",
  "    public static string Text(decimal value, int scale) =>",
  "        value.ToString(\"F\" + scale.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);",
  "",
  "    /// <summary>",
  "    /// A string, as the contract writes it — and a number too, because a payload from a producer",
  "    /// that got it wrong is better rejected by the validator than by the parser.",
  "    /// </summary>",
  "    public static decimal Read(ref Utf8JsonReader reader) =>",
  "        reader.TokenType == JsonTokenType.String",
  "            ? decimal.Parse(reader.GetString()!, NumberStyles.Number, CultureInfo.InvariantCulture)",
  "            : reader.GetDecimal();",
  "}",
  "",
  "/// <summary>Reading and writing `bytes` the way the contract spells it.</summary>",
  "public static class Bytes",
  "{",
  "    /// <summary>base64url, unpadded.</summary>",
  "    public static string Text(IReadOnlyList<byte> value)",
  "    {",
  "        var bytes = value is byte[] array ? array : value.ToArray();",
  "        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');",
  "    }",
  "",
  "    /// <summary>base64url in, padding restored because `FromBase64String` insists on it.</summary>",
  "    public static IReadOnlyList<byte> Read(ref Utf8JsonReader reader)",
  "    {",
  "        var text = (reader.GetString() ?? string.Empty).Replace('-', '+').Replace('_', '/');",
  "        text += (text.Length % 4) switch { 2 => \"==\", 3 => \"=\", _ => \"\" };",
  "        return Convert.FromBase64String(text);",
  "    }",
  "}",
  "",
  "/// <summary>Reading and writing an `instant`.</summary>",
  "public static class Instants",
  "{",
  "    /// <summary>RFC 3339, UTC, microsecond precision.</summary>",
  "    public static string Text(DateTimeOffset value) =>",
  "        value.ToUniversalTime().ToString(\"yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'\", CultureInfo.InvariantCulture);",
  "",
  "    /// <inheritdoc cref=\"Text\" />",
  "    public static DateTimeOffset Read(ref Utf8JsonReader reader) =>",
  "        DateTimeOffset.Parse(",
  "            reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);",
  "}",
  "",
  "/// <summary>`bytes`, as base64url without padding (`01-kernel.md` 7.1).</summary>",
  "/// <remarks>",
  "/// <para>",
  "/// Not `Convert.ToBase64String`, which is standard base64: the `+` and `/` it produces are not",
  "/// URL-safe and the `=` padding is not what the contract says. A payload differing only in that is",
  "/// still a different payload.",
  "/// </para>",
  "/// </remarks>",
  "public sealed class BytesConverter : JsonConverter<IReadOnlyList<byte>>",
  "{",
  "    /// <inheritdoc />",
  "    public override IReadOnlyList<byte> Read(",
  "        ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)",
  "    {",
  "        var text = reader.GetString() ?? string.Empty;",
  "        var padded = text.Replace('-', '+').Replace('_', '/');",
  "        padded += (padded.Length % 4) switch { 2 => \"==\", 3 => \"=\", _ => \"\" };",
  "        return Convert.FromBase64String(padded);",
  "    }",
  "",
  "    /// <inheritdoc />",
  "    public override void Write(",
  "        Utf8JsonWriter writer, IReadOnlyList<byte> value, JsonSerializerOptions options)",
  "    {",
  "        var bytes = value is byte[] array ? array : value.ToArray();",
  "        writer.WriteStringValue(",
  "            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'));",
  "    }",
  "}",
  "",
  "/// <summary>An `instant`: RFC 3339, UTC, microsecond precision.</summary>",
  "/// <remarks>",
  "/// <para>",
  "/// An instant is absolute, so it is written in UTC whatever offset it was built with — two",
  "/// encodings of one moment would be two bytes for one value. Microseconds and not ticks, because",
  "/// that is what the contract says and a consumer parsing to microseconds would round the rest.",
  "/// </para>",
  "/// </remarks>",
  "public sealed class InstantConverter : JsonConverter<DateTimeOffset>",
  "{",
  "    /// <inheritdoc />",
  "    public override DateTimeOffset Read(",
  "        ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>",
  "        DateTimeOffset.Parse(",
  "            reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);",
  "",
  "    /// <inheritdoc />",
  "    public override void Write(",
  "        Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>",
  "        writer.WriteStringValue(",
  "            value.ToUniversalTime().ToString(\"yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'\", CultureInfo.InvariantCulture));",
  "}",
  "",
  "/// <summary>A `duration`: ISO 8601 on output, 7K's own literals accepted on input.</summary>",
  "public sealed class DurationConverter : JsonConverter<TimeSpan>",
  "{",
  "    /// <inheritdoc />",
  "    public override TimeSpan Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>",
  "        Durations.Parse(reader.GetString() ?? \"PT0S\");",
  "",
  "    /// <inheritdoc />",
  "    public override void Write(Utf8JsonWriter writer, TimeSpan value, JsonSerializerOptions options) =>",
  "        writer.WriteStringValue(Durations.Text(value));",
  "}",
  "",
  "/// <summary>ISO 8601 durations, over the subset 7K's `duration` can hold.</summary>",
  "public static class Durations",
  "{",
  "    /// <summary>`PT30S`, `PT1H30M`, `P2DT3H`. Zero is `PT0S`.</summary>",
  "    public static string Text(TimeSpan value)",
  "    {",
  "        if (value == TimeSpan.Zero) return \"PT0S\";",
  "        var sign = value < TimeSpan.Zero ? \"-\" : string.Empty;",
  "        var it = value.Duration();",
  "        var text = new StringBuilder(sign).Append('P');",
  "        if (it.Days > 0) text.Append(it.Days.ToString(CultureInfo.InvariantCulture)).Append('D');",
  "        var seconds = it.Seconds + (it.Milliseconds / 1000m);",
  "        if (it.Hours > 0 || it.Minutes > 0 || seconds > 0) text.Append('T');",
  "        if (it.Hours > 0) text.Append(it.Hours.ToString(CultureInfo.InvariantCulture)).Append('H');",
  "        if (it.Minutes > 0) text.Append(it.Minutes.ToString(CultureInfo.InvariantCulture)).Append('M');",
  "        if (seconds > 0) text.Append(seconds.ToString(\"0.###\", CultureInfo.InvariantCulture)).Append('S');",
  "        return text.ToString();",
  "    }",
  "",
  "    /// <summary>ISO 8601, or a 7K literal such as `30s` or `1h30m`.</summary>",
  "    public static TimeSpan Parse(string text)",
  "    {",
  "        var trimmed = text.Trim();",
  "        if (trimmed.Length == 0) return TimeSpan.Zero;",
  "",
  "        var negative = trimmed[0] == '-';",
  "        if (negative || trimmed[0] == '+') trimmed = trimmed.Substring(1);",
  "",
  "        var total = TimeSpan.Zero;",
  "        var iso = trimmed.StartsWith(\"P\", StringComparison.OrdinalIgnoreCase);",
  "        var time = !iso;",
  "        var number = new StringBuilder();",
  "",
  "        foreach (var c in iso ? trimmed.Substring(1) : trimmed)",
  "        {",
  "            if (char.IsDigit(c) || c == '.') { number.Append(c); continue; }",
  "            if (c is 'T' or 't') { time = true; continue; }",
  "",
  "            var value = number.Length == 0",
  "                ? 0m",
  "                : decimal.Parse(number.ToString(), CultureInfo.InvariantCulture);",
  "            number.Clear();",
  "",
  "            total += (char.ToLowerInvariant(c), time) switch",
  "            {",
  "                ('d', _) => TimeSpan.FromDays((double)value),",
  "                ('h', _) => TimeSpan.FromHours((double)value),",
  "                ('m', true) => TimeSpan.FromMinutes((double)value),",
  "                // `M` outside a time part is months in ISO 8601, which a `duration` cannot hold.",
  "                ('m', false) => throw new FormatException($\"`{text}` is a calendar duration, which 7K's `duration` cannot hold\"),",
  "                ('s', _) => TimeSpan.FromSeconds((double)value),",
  "                ('w', _) => TimeSpan.FromDays((double)value * 7),",
  "                _ => throw new FormatException($\"`{text}` is not a duration this understands\"),",
  "            };",
  "        }",
  "",
  "        return negative ? total.Negate() : total;",
  "    }",
  "}",
  "",
  "/// <summary>The options canonical 7K JSON needs, for a host that would rather not assemble them.</summary>",
  "/// <remarks>",
  "/// <para>",
  "/// Every rule that *can* travel on the type travels on the type, so these options are thin on",
  "/// purpose: a payload written with plain `JsonSerializerOptions` is still canonical. What is here is",
  "/// the one thing an attribute cannot say — that an absent optional field has its key omitted rather",
  "/// than written as `null` (`01-kernel.md` 7.2).",
  "/// </para>",
  "/// </remarks>",
  "public static class SevenKJson",
  "{",
  "    /// <summary>Options producing canonical 7K JSON.</summary>",
  "    public static JsonSerializerOptions Options { get; } = Create();",
  "",
  "    /// <summary>A fresh set, for a host that wants to add to them.</summary>",
  "    public static JsonSerializerOptions Create() => new()",
  "    {",
  "        // There is no null in 7K: an optional field with no value has its key omitted, and a `null`",
  "        // in a payload is a validation error naming the field.",
  "        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,",
  "    };",
  "}",
];

/* ------------------------------------------------------------------ generated */

/** A converter for one nominal value, so it encodes as the thing it refines. */
export function valueConverter(decl: ValueIr, ctx: TypeContext, support: string): string[] {
  const name = pascal(decl.id.name);
  const base = csharpType(decl.base, ctx, decl.id.name);
  const kind = baseKind(decl.base);

  /**
   * Whether this `int` is carried as text.
   *
   * `01-kernel.md` 7.1: an `int` whose declared range can exceed ±(2^53 − 1) travels as a string,
   * because a JSON number is a double and anything past that comes back changed. A `long` holds it
   * exactly in memory, and `WriteNumberValue` would still emit every digit — but the reader on the
   * other side is as likely to be JavaScript, where those digits round on the way in. The encoding
   * is about what crosses, not about what either end can hold.
   *
   * The decision is 7K Core's `intIsWide`, the same function the TypeScript provider asks, so the two
   * cannot disagree about which fields this applies to.
   */
  const wideInt = kind.k === "int" && intIsWide({ constraints: decl.constraints });

  const read = ((): string => {
    switch (kind.k) {
      case "decimal":
        return `${support}Decimals.Read(ref reader)`;
      case "bytes":
        return `${support}Bytes.Read(ref reader)`;
      case "instant":
        return `${support}Instants.Read(ref reader)`;
      case "duration":
        return `${support}Durations.Parse(reader.GetString()!)`;
      case "uuid":
        return "reader.GetGuid()";
      case "int":
        // `AllowReadingFromString` is not in play here: this converter owns the read, so it takes the
        // form the model declares and says so when it gets the other one.
        return wideInt ? "long.Parse(reader.GetString()!, CultureInfo.InvariantCulture)" : "reader.GetInt64()";
      case "float":
        return "reader.GetDouble()";
      case "bool":
        return "reader.GetBoolean()";
      case "string":
        return "reader.GetString()!";
      default:
        // A date, an enum, a record or a collection: the serialiser already handles each of those,
        // with whatever converter the type it points at carries.
        return `JsonSerializer.Deserialize<${base.text}>(ref reader, options)!`;
    }
  })();

  const write = ((): string => {
    switch (kind.k) {
      case "decimal":
        return `writer.WriteStringValue(${support}Decimals.Text(value.Value, ${kind.scale}))`;
      case "bytes":
        return `writer.WriteStringValue(${support}Bytes.Text(value.Value))`;
      case "instant":
        return `writer.WriteStringValue(${support}Instants.Text(value.Value))`;
      case "duration":
        return `writer.WriteStringValue(${support}Durations.Text(value.Value))`;
      case "int":
        return wideInt
          ? "writer.WriteStringValue(value.Value.ToString(CultureInfo.InvariantCulture))"
          : "writer.WriteNumberValue(value.Value)";
      case "float":
        return "writer.WriteNumberValue(value.Value)";
      case "bool":
        return "writer.WriteBooleanValue(value.Value)";
      case "uuid":
      case "string":
        return "writer.WriteStringValue(value.Value)";
      default:
        return "JsonSerializer.Serialize(writer, value.Value, options)";
    }
  })();

  // A map key is written as a property name, which is always text. Section 7.1 says a map's keys are
  // the string-rooted key type, so a value refining a collection or a record cannot be one - and
  // saying so where it would be needed beats writing something nothing can parse back.
  const keyable = kind.k !== "other" && kind.k !== "date";

  const asName = ((): string => {
    switch (kind.k) {
      case "decimal":
        return `writer.WritePropertyName(${support}Decimals.Text(value.Value, ${kind.scale}))`;
      case "bytes":
        return `writer.WritePropertyName(${support}Bytes.Text(value.Value))`;
      case "instant":
        return `writer.WritePropertyName(${support}Instants.Text(value.Value))`;
      case "duration":
        return `writer.WritePropertyName(${support}Durations.Text(value.Value))`;
      case "string":
        return "writer.WritePropertyName(value.Value)";
      default:
        return "writer.WritePropertyName(value.Value.ToString()!)";
    }
  })();

  const unsupported =
    `throw new NotSupportedException(${quote(
      `\`${decl.id.name}\` refines something a map key cannot be.`,
    )})`;

  const qualified = decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

  return [
    `/// <summary>\`${qualified}\`, as the value it refines rather than an object wrapping one.</summary>`,
    `public sealed class ${name}JsonConverter : JsonConverter<${name}>`,
    "{",
    ...indent([
      "/// <inheritdoc />",
      `public override ${name} Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>`,
      `    new(${read});`,
      "",
      "/// <inheritdoc />",
      `public override void Write(Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options) =>`,
      `    ${write};`,
      "",
      "/// <summary>As a map key, which is written as a property name.</summary>",
      "public override void WriteAsPropertyName(",
      `    Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options) =>`,
      `    ${keyable ? asName : unsupported};`,
      "",
      "/// <summary>And read back from one.</summary>",
      `public override ${name} ReadAsPropertyName(`,
      "    ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>",
      `    ${keyable ? `new(${propertyNameRead(decl.base, base.text, support)})` : unsupported};`,
    ]),
    "}",
  ];
}

/** What a value refines, as far as its encoding is concerned. */
type BaseKind =
  | { readonly k: "decimal"; readonly scale: number }
  | {
      readonly k:
        | "bytes"
        | "instant"
        | "duration"
        | "date"
        | "uuid"
        | "int"
        | "float"
        | "bool"
        | "string"
        | "other";
    };

function baseKind(type: TypeIr): BaseKind {
  // A value refining another value, a record or a collection encodes as whatever that does, and
  // carries that type's own converter rather than needing a case here.
  if (type.t !== "kernel") return { k: "other" };
  if (type.name === "decimal") return { k: "decimal", scale: type.scale ?? 0 };
  switch (type.name) {
    case "bytes":
    case "instant":
    case "duration":
    case "date":
    case "uuid":
    case "int":
    case "float":
    case "bool":
    case "string":
      return { k: type.name };
    default:
      return { k: "other" };
  }
}

/** A map key arrives as a property name, which is always text. */
function propertyNameRead(inner: TypeIr, base: string, support: string): string {
  if (inner.t !== "kernel") return `JsonSerializer.Deserialize<${base}>(reader.GetString()!, options)!`;
  switch (inner.name) {
    case "string":
      return "reader.GetString()!";
    case "uuid":
      return "Guid.Parse(reader.GetString()!)";
    case "int":
      return "long.Parse(reader.GetString()!, CultureInfo.InvariantCulture)";
    case "decimal":
      return `${support}Decimals.Read(ref reader)`;
    case "bytes":
      return `${support}Bytes.Read(ref reader)`;
    case "instant":
      return `${support}Instants.Read(ref reader)`;
    case "duration":
      return `${support}Durations.Parse(reader.GetString()!)`;
    case "float":
      return "double.Parse(reader.GetString()!, NumberStyles.Float, CultureInfo.InvariantCulture)";
    case "bool":
      return "bool.Parse(reader.GetString()!)";
    default:
      return "reader.GetString()!";
  }
}

/**
 * A converter for one enum, writing the member name the model declared.
 *
 * Generated rather than `JsonStringEnumConverter`, which writes the *C# name* — and the C# name is the
 * PascalCase of the 7K one, so a model spelling a member any other way would silently encode something
 * the contract does not mention.
 */
export function enumConverter(decl: EnumIr, ctx: TypeContext): string[] {
  const name = pascal(decl.id.name);
  void ctx;

  return [
    `/// <summary>\`${decl.id.name}\`, as the member name the model declares and never as an index.</summary>`,
    `public sealed class ${name}JsonConverter : JsonConverter<${name}>`,
    "{",
    ...indent([
      "/// <inheritdoc />",
      `public override ${name} Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>`,
      "    reader.GetString() switch",
      "    {",
      ...decl.members.map((m) => `        ${quote(m.name)} => ${name}.${pascal(m.name)},`),
      `        var other => throw new JsonException($"\`{other}\` is not a member of \`${decl.id.name}\`"),`,
      "    };",
      "",
      "/// <inheritdoc />",
      `public override void Write(Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options) =>`,
      "    writer.WriteStringValue(Text(value));",
      "",
      "/// <summary>As a map key.</summary>",
      "public override void WriteAsPropertyName(",
      `    Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options) =>`,
      "    writer.WritePropertyName(Text(value));",
      "",
      `private static string Text(${name} value) => value switch`,
      "{",
      ...decl.members.map((m) => `    ${name}.${pascal(m.name)} => ${quote(m.name)},`),
      `    _ => throw new JsonException($"\`{value}\` is not a member of \`${decl.id.name}\`"),`,
      "};",
    ]),
    "}",
  ];
}

/** `[JsonConverter(typeof(X))]` on the type itself, so a plain serialiser call is still canonical. */
export const converterAttribute = (decl: Decl): string[] =>
  decl.kind === "value" || decl.kind === "enum"
    ? [`[JsonConverter(typeof(${pascal(decl.id.name)}JsonConverter))]`]
    : [];

/** Qualified absolutely, for the same reason every cross-namespace reference is. */
const supportType = (support: string, name: string): string => `${support}${name}`;

/**
 * The attributes one field needs.
 *
 * `JsonPropertyName` on every one, because the contract names a field and PascalCase is this
 * provider's own convention. Putting it on the type rather than in a host's options is what makes a
 * payload canonical whoever serialises it.
 */
export function fieldAttributes(field: FieldIr, ctx: TypeContext, support: string): string[] {
  const out = [`[JsonPropertyName(${quote(field.name)})]`];

  // A kernel type whose encoding is not what a serialiser does by default. A `ref` carries its own
  // converter on the type it points at, so nothing is needed here.
  const scalar = field.type.t === "list" ? field.type.item : field.type;
  if (scalar.t === "kernel") {
    switch (scalar.name) {
      case "decimal":
        out.push(`[${supportType(support, "SevenKDecimal")}(${scalar.scale ?? 0})]`);
        break;
      case "bytes":
        out.push(`[JsonConverter(typeof(${supportType(support, "BytesConverter")}))]`);
        break;
      case "instant":
        out.push(`[JsonConverter(typeof(${supportType(support, "InstantConverter")}))]`);
        break;
      case "duration":
        out.push(`[JsonConverter(typeof(${supportType(support, "DurationConverter")}))]`);
        break;
      default:
        break;
    }
  }

  void ctx;
  return out;
}

/** The `using` lines the attributes and converters need. */
export const JSON_USINGS: readonly string[] = [
  // A generated converter parses and formats, and neither may use the ambient culture: `1,5` and
  // `1.5` are not the same decimal, and a contract cannot depend on where it was serialised.
  "using System.Globalization;",
  "using System.Text.Json;",
  "using System.Text.Json.Serialization;",
];

/** What the support file itself needs, which is more than a generated type does. */
export const JSON_SUPPORT_USINGS: readonly string[] = [
  "using System.Globalization;",
  "using System.Linq;",
  "using System.Text;",
  "using System.Text.Json;",
  "using System.Text.Json.Serialization;",
];
