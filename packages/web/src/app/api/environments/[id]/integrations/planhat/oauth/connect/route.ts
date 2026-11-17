import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy<{ id: string }>(
  ({ id }) => `/environments/${encodeURIComponent(id)}/integrations/planhat/oauth/connect`,
  "Planhat OAuth connection"
);
