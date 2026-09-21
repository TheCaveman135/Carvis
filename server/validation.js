export function validate(value, schema, path = "arguments") {
  if (!schema) return;
  if (schema.enum && !schema.enum.includes(value))
    throw Error(`${path}: choose a supported value.`);
  if (value === null && schema.nullable) return;
  switch (schema.type) {
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error(`${path} must be an object.`);
      for (const k of schema.required || [])
        if (value[k] === undefined) throw Error(`${path}.${k} is required.`);
      for (const [k, v] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(k))
          throw Error("Invalid key.");
        if (schema.properties?.[k])
          validate(v, schema.properties[k], `${path}.${k}`);
        else if (schema.additionalProperties === false)
          throw Error(`${path}.${k} is not supported.`);
        else if (typeof schema.additionalProperties === "object")
          validate(v, schema.additionalProperties, `${path}.${k}`);
      }
      break;
    case "array":
      if (!Array.isArray(value)) throw Error(`${path} must be a list.`);
      if (
        value.length < (schema.minItems ?? 0) ||
        value.length > (schema.maxItems ?? 1000)
      )
        throw Error(`${path} has an invalid length.`);
      if (
        schema.uniqueItems &&
        new Set(value.map((v) => JSON.stringify(v))).size !== value.length
      )
        throw Error(`${path} contains duplicates.`);
      value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`));
      break;
    case "string":
      if (
        typeof value !== "string" ||
        value.length > (schema.maxLength ?? 20000) ||
        value.length < (schema.minLength ?? 0)
      )
        throw Error(`${path} must be text of an allowed length.`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value))
        throw Error(`${path} is invalid.`);
      break;
    case "integer":
    case "number":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isInteger(value)) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      )
        throw Error(`${path} must be a number in range.`);
      break;
    case "boolean":
      if (typeof value !== "boolean")
        throw Error(`${path} must be true or false.`);
      break;
  }
}
export function endpoint(value) {
  const url = new URL(String(value));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw Error(
      "Use an HTTP or HTTPS URL without embedded credentials or query parameters.",
    );
  return url.toString().replace(/\/+$/, "");
}
export function text(value, max = 4000) {
  if (typeof value !== "string" || value.length > max)
    throw Error(`Enter text up to ${max} characters.`);
  return value.trim();
}
