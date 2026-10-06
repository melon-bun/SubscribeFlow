-- NULL means unset on a source, and inherit on an individual content item.
ALTER TABLE subscriptions ADD COLUMN default_priority TEXT
    CHECK(default_priority IN ('high','medium','low'));
ALTER TABLE content_states ADD COLUMN priority_override TEXT
    CHECK(priority_override IN ('high','medium','low'));
