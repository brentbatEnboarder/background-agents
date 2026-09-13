ALTER TABLE automations ADD COLUMN slack_delivery_channel TEXT
  CHECK (
    slack_delivery_channel IS NULL OR (
      length(slack_delivery_channel) >= 9
      AND substr(slack_delivery_channel, 1, 1) IN ('C', 'G')
      AND slack_delivery_channel NOT GLOB '*[^A-Z0-9]*'
    )
  );
