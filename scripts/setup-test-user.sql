BEGIN;
INSERT INTO users (id, email, password_hash, role, display_name)
VALUES ('67b84cb5-4b3e-48f9-8508-50ffb5c97b34', 'rc-test@example.test', '$2a$10$4vYkgPsuOeU1olIu1VCNhuhnkFCnuiw0599i0MZrELR12063eM4ze', 'owner', 'RC Test User')
ON CONFLICT (email) DO NOTHING;
INSERT INTO workspaces (id, owner_id, name, workspace_type)
VALUES ('550e8400-e29b-41d4-a716-446655440000', '67b84cb5-4b3e-48f9-8508-50ffb5c97b34', 'RC Test Workspace', 'personal')
ON CONFLICT (id) DO NOTHING;
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('550e8400-e29b-41d4-a716-446655440000', '67b84cb5-4b3e-48f9-8508-50ffb5c97b34', 'owner')
ON CONFLICT (workspace_id, user_id) DO NOTHING;
UPDATE users SET personal_workspace_id = '550e8400-e29b-41d4-a716-446655440000' WHERE id = '67b84cb5-4b3e-48f9-8508-50ffb5c97b34';
COMMIT;
