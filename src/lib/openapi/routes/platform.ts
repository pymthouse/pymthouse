import { registerJsonRouteMetadata } from "@/lib/openapi/routes/shared";

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/prices/eth-usd",
  tags: ["Platform"],
  summary: "ETH/USD spot price",
  statusDescription: "Price snapshot",
});
