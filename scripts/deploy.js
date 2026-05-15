const { ethers, artifacts } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Deploy — deployer is also the initial treasurer
  const CreditUnion = await ethers.getContractFactory("CreditUnion");
  const cu = await CreditUnion.deploy(deployer.address);
  await cu.waitForDeployment();

  const address = await cu.getAddress();
  console.log("CreditUnion deployed to:", address);
  console.log("Treasurer:              ", deployer.address);

  const frontendDir = path.join(__dirname, "../frontend");
  if (!fs.existsSync(frontendDir)) fs.mkdirSync(frontendDir, { recursive: true });

  fs.writeFileSync(
    path.join(frontendDir, "contractAddress.json"),
    JSON.stringify({ address }, null, 2)
  );
  console.log("→ frontend/contractAddress.json written");

  const artifact = await artifacts.readArtifact("CreditUnion");
  fs.writeFileSync(
    path.join(frontendDir, "contractABI.json"),
    JSON.stringify(artifact.abi, null, 2)
  );
  console.log("→ frontend/contractABI.json written");

  console.log("\nQuick-start:");
  console.log("  npm run serve          # start frontend on :3000");
  console.log("  Open http://localhost:3000 in your browser");
  console.log("  Select any account from the dropdown — no wallet extension needed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
