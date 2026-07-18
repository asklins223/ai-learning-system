import bcrypt from "bcryptjs";
import { db } from "./client.ts";
import { users, workspaces, workspaceMembers } from "./schema/identity.ts";

const DEMO_OWNER_EMAIL = "owner@ailearn.local";
const DEMO_OWNER_PASSWORD = "ailearn_owner";
const DEMO_WORKSPACE_NAME = "Personal Beta";

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

function required(name: "OWNER_EMAIL" | "OWNER_PASSWORD"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Production seeding never uses a default owner account.`,
    );
  }
  return value;
}

function resolveSeedConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  const demoSeed = process.env.SEED_DEMO_DATA === "true";

  if (isProduction && demoSeed) {
    throw new Error(
      "SEED_DEMO_DATA is disabled in production. Set OWNER_EMAIL and OWNER_PASSWORD explicitly.",
    );
  }
  if (isProduction && !process.env.DATABASE_URL_API?.trim()) {
    throw new Error("DATABASE_URL_API is required for production seeding.");
  }

  const ownerEmail = demoSeed
    ? process.env.OWNER_EMAIL?.trim() || DEMO_OWNER_EMAIL
    : required("OWNER_EMAIL");
  const ownerPassword = demoSeed
    ? process.env.OWNER_PASSWORD || DEMO_OWNER_PASSWORD
    : required("OWNER_PASSWORD");
  const workspaceName =
    process.env.OWNER_WORKSPACE?.trim() ||
    (demoSeed ? DEMO_WORKSPACE_NAME : "Personal Workspace");

  if (!ownerEmail.includes("@")) {
    throw new Error("OWNER_EMAIL must be a valid email address.");
  }
  if (ownerPassword.length < 12) {
    throw new Error("OWNER_PASSWORD must contain at least 12 characters.");
  }

  return { demoSeed, ownerEmail, ownerPassword, workspaceName };
}

async function main() {
  console.log("Seeding…");

  const { demoSeed, ownerEmail, ownerPassword, workspaceName } = resolveSeedConfig();

  const existing = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, ownerEmail),
  });

  if (existing) {
    console.log(`Owner already exists: ${ownerEmail}`);
    return;
  }

  const [owner] = await db
    .insert(users)
    .values({
      email: ownerEmail,
      passwordHash: hashPassword(ownerPassword),
      role: "owner",
    })
    .returning();

  const [ws] = await db
    .insert(workspaces)
    .values({ ownerId: owner.id, name: workspaceName })
    .returning();

  await db.insert(workspaceMembers).values({
    workspaceId: ws.id,
    userId: owner.id,
    role: "owner",
  });

  console.log(`Seeded ${demoSeed ? "demo " : ""}owner: ${ownerEmail}`);
  console.log(`Workspace: ${workspaceName} (${ws.id})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
