import { settingsProxy } from "@/lib/settings-proxy";

export const { DELETE, GET } = settingsProxy<{ id: string }>(
  ({ id }) => `/environments/${encodeURIComponent(id)}/integrations/planhat/oauth`,
  "Planhat OAuth connection"
);
