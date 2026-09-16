ALTER TABLE automations ADD COLUMN slack_delivery_mention_user_id TEXT
  CHECK (
    slack_delivery_mention_user_id IS NULL OR (
      slack_delivery_channel IS NOT NULL
      AND length(slack_delivery_mention_user_id) >= 2
      AND substr(slack_delivery_mention_user_id, 1, 1) IN ('U', 'W')
      AND slack_delivery_mention_user_id NOT GLOB '*[^A-Z0-9]*'
    )
  );
