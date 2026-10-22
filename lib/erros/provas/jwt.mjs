// Minta um JWT HS256 para o stack DESCARTAVEL de teste. O segredo e o padrao publico do
// Supabase local; nada disto e credencial. Uso: node jwt.mjs <segredo> <role> [sub] [app_metadata-json]
import crypto from "node:crypto";
const [, , segredo, role, sub, app] = process.argv;
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b({ alg: "HS256", typ: "JWT" });
const p = b({
  iss: "supabase-demo",
  role,
  ...(sub ? { sub, aud: "authenticated" } : {}),
  ...(app ? { app_metadata: JSON.parse(app) } : {}),
  exp: 4102444800,
});
console.log(`${h}.${p}.${crypto.createHmac("sha256", segredo).update(`${h}.${p}`).digest("base64url")}`);
