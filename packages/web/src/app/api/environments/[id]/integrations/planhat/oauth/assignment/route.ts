import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT } = settingsProxy<{ id: string }>(
  ({ id }) => `/environments/${encodeURIComponent(id)}/integrations/planhat/oauth/assignment`,
  "Planhat OAuth assignment"
);
