import { handleApi } from "../../lib/cloud-api.mjs";

export function onRequest({ request, env }) {
  return handleApi(request, env);
}
