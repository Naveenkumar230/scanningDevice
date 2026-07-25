// Run this on your own machine (NOT in this chat) to check whether your
// .env file actually connects to MongoDB Atlas.
//
// Setup (one time):
//   cd sewing-dashboard
//   npm install mongodb dotenv
//
// Then run:
//   node test-mongo-connection.js
//
// (Put this file in the same folder as your .env)

require("dotenv").config();
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "sewingDashboard";

if (!uri) {
    console.error("❌ MONGODB_URI is not set in your .env file.");
    process.exit(1);
}

async function main() {
    console.log("Attempting to connect to MongoDB Atlas...");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    try {
        await client.connect();
        await client.db(dbName).command({ ping: 1 });
        console.log(`✅ Connected successfully to database "${dbName}".`);

        const collections = await client.db(dbName).listCollections().toArray();
        console.log(`Collections found: ${collections.map((c) => c.name).join(", ") || "(none yet)"}`);
    } catch (err) {
        console.error("❌ Connection failed:", err.message);
        console.error("Common causes: wrong password, password not URL-encoded if it has special characters,");
        console.error("Network Access not set to allow your current IP / 0.0.0.0/0, or a typo in the cluster address.");
    } finally {
        await client.close();
    }
}

main();