-- Historical daily Risk Radar rows intentionally have NULL anchors.
alter table crash_checks add column risk_radar_anchors jsonb;