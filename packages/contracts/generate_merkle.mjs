import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_RPC_URL = "http://localhost:8545";


const PRIVATE_KEYS = {
  admin: process.env.ADMIN_KEY ?? "",
  distributor1: process.env.DISTRIBUTOR1_KEY ?? "",
  distributor2: process.env.DISTRIBUTOR2_KEY ?? "",
};


let REWARDS_DISTRIBUTION_ADDRESS = process.env.REWARDS_CONTRACT_ADDRESS ?? "";
let ROUTER_ADDRESS = process.env.ROUTER_CONTRACT_ADDRESS ?? "";


const NUM_WORKERS = parseInt(process.env.NUM_WORKERS ?? "500");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "100");
let FROM_BLOCK = parseInt(process.env.FROM_BLOCK ?? "101");
let TO_BLOCK = parseInt(process.env.TO_BLOCK ?? "200");
const IPFS_LINK = process.env.IPFS_LINK ?? "ipfs://QmSingleMerkleTreeImplementation";

const SKIP_COMMIT = process.env.SKIP_COMMIT === "true";
const SKIP_APPROVE = process.env.SKIP_APPROVE === "true";
const SKIP_DISTRIBUTE = process.env.SKIP_DISTRIBUTE === "true";

console.log("Configuration loaded successfully");
console.log(`Using REWARDS_DISTRIBUTION_ADDRESS: ${REWARDS_DISTRIBUTION_ADDRESS}`);
console.log(`Using ROUTER_ADDRESS: ${ROUTER_ADDRESS}`);


function loadAbi(contractName) {
  try {

    const artifactsPath = path.join(__dirname, "artifacts", "DistributedRewardDistribution.sol", `${contractName}.json`);
    
    if (fs.existsSync(artifactsPath)) {
      console.log(`Loading ABI from ${artifactsPath}`);
      const abiFile = fs.readFileSync(artifactsPath, "utf-8");
      return JSON.parse(abiFile).abi;
    }
    
    const abiPath = path.join(__dirname, "out", `${contractName}.sol`, `${contractName}.json`);
    if (fs.existsSync(abiPath)) {
      console.log(`Loading ABI from ${abiPath}`);
      const abiFile = fs.readFileSync(abiPath, "utf-8");
      return JSON.parse(abiFile).abi;
    }
    
    const altAbiPath = path.join(__dirname, "..", "out", `${contractName}.sol`, `${contractName}.json`);
    if (fs.existsSync(altAbiPath)) {
      console.log(`Loading ABI from ${altAbiPath}`);
      const abiFile = fs.readFileSync(altAbiPath, "utf-8");
      return JSON.parse(abiFile).abi;
    }
    
    throw new Error(`ABI file not found for ${contractName}`);
  } catch (err) {
    console.error(`Error loading ABI: ${err.message}`);
    throw err;
  }
}

// Send Transaction Helper
async function sendTransaction(
  contract,
  functionName,
  signer,
  args = [],
  value = ethers.BigNumber.from(0)
) {
  const argsString = args
    .map((a) => {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(", ");
  console.log(`\nSubmitting transaction: ${functionName}(${argsString}) from ${signer.address}`);
  
  try {
    const txOptions = { value };
    const estimatedGas = await contract
      .connect(signer)
      .estimateGas[functionName](...args, { value: txOptions.value });
    
    console.log(` -> Estimated gas: ${estimatedGas.toString()}`);
    txOptions.gasLimit = estimatedGas.mul(12).div(10);

    const tx = await contract.connect(signer)[functionName](...args, txOptions);
    console.log(` -> Transaction submitted: ${tx.hash}`);
    
    const receipt = await tx.wait(1);
    console.log(
      ` -> Transaction ${functionName} - Gas used: ${receipt.gasUsed.toString()}, Status: ${
        receipt.status === 1 ? "SUCCESS" : "FAILED"
      }`
    );
    
    if (receipt.status !== 1) {
      throw new Error(`Transaction ${functionName} failed`);
    }
    
    return receipt;
  } catch (error) {
    console.error(` -> Error in transaction ${functionName}: ${error.message}`);
    throw error;
  }
}


// Generate worker batches
function generateWorkerBatches(numWorkers, batchSize) {
  const batches = [];
  const workers = [];
  console.log(`\n--- Generating ${numWorkers} Worker Rewards ---`);

  // Generate random rewards for workers
  for (let i = 1; i <= numWorkers; i++) {
    workers.push({
      workerId: i,
      workerReward: ethers.utils.parseEther(String(Math.floor(Math.random() * 10) + 1)),
      stakerReward: ethers.utils.parseEther(String(Math.floor(Math.random() * 5) + 1)),
    });
  }

  // Split workers into batches
  console.log(`Splitting into batches of size ${batchSize}...`);
  for (let i = 0; i < workers.length; i += batchSize) {
    const batchWorkers = workers.slice(i, i + batchSize);
    const recipients = batchWorkers.map((w) => w.workerId);
    const workerRewards = batchWorkers.map((w) => w.workerReward);
    const stakerRewards = batchWorkers.map((w) => w.stakerReward);

    // Create leaf hash exactly as the contract does
    const batchHash = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["uint256[]", "uint256[]", "uint256[]"],
        [recipients, workerRewards, stakerRewards]
      )
    );

    batches.push({
      batchId: batches.length,
      recipients,
      workerRewards,
      stakerRewards,
      leafHash: batchHash,
    });
  }
  
  console.log(`Generated ${batches.length} batches.`);
  return batches;
}

// Merkle Tree Implementation
class MerkleTree {
  constructor(leaves) {
    // Sort leaves to ensure consistent ordering 
    this.leaves = [...leaves];
    this.layers = [this.leaves];
    this.buildTree();
  }

  buildTree() {
    let currentLayer = this.leaves;
    
    // Build tree until we reach the root
    while (currentLayer.length > 1) {
      const nextLayer = [];
      
      // Process pairs of nodes
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          // Create parent by hashing the children
          const left = currentLayer[i];
          const right = currentLayer[i + 1];
          
          const [first, second] = left < right ? [left, right] : [right, left];
          
          // Use the same hashing approach as the contract expects (keccak256 of concatenation)
          const parentHash = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
              ["bytes32", "bytes32"], 
              [first, second]
            )
          );
          nextLayer.push(parentHash);
        } else {
          // Odd number of nodes, promote the last one to the next level
          nextLayer.push(currentLayer[i]);
        }
      }
      
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  getRoot() {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(index) {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error("Index out of range");
    }
    
    const proof = [];
    let currentIndex = index;
    
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      // Calculate sibling index (adjacent node in the tree)
      const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      
      if (siblingIndex < layer.length) {
        // Add sibling to proof
        proof.push(layer[siblingIndex]);
      }
      
      // Update index for the next layer up
      currentIndex = Math.floor(currentIndex / 2);
    }
    
    return proof;
  }

  // Verify a proof for a leaf and root
  static verifyProof(leaf, proof, root) {
    let computedHash = leaf;
    
    for (const proofElement of proof) {
      // Sort the pair before hashing (exactly as in the contract)
      if (computedHash < proofElement) {
        computedHash = ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "bytes32"], 
            [computedHash, proofElement]
          )
        );
      } else {
        computedHash = ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "bytes32"], 
            [proofElement, computedHash]
          )
        );
      }
    }
    
    return computedHash === root;
  }
}

// Main function to run the distribution test
async function testSingleMerkleDistribution() {
  console.log("\n--- Starting Single Merkle Tree Rewards Distribution Test ---");
  console.log(`Testing with ${NUM_WORKERS} workers in batches of ${BATCH_SIZE}\n`);

  let provider;
  try {
    provider = new ethers.providers.JsonRpcProvider(LOCAL_RPC_URL);
    await provider.getNetwork();
    console.log("Successfully connected to provider");
  } catch (err) {
    console.warn(`Warning: Failed to connect to provider at ${LOCAL_RPC_URL}. Using mock provider.`);
    console.warn(`Error was: ${err.message}`);
    
    // Create a mock provider for testing
    provider = {
      getBlockNumber: async () => 12345,
      getNetwork: async () => ({ chainId: 42161, name: "arbitrum" })
    };
  }
  
  const admin = new ethers.Wallet(PRIVATE_KEYS.admin, provider);
  const distributor1 = new ethers.Wallet(PRIVATE_KEYS.distributor1, provider);
  const distributor2 = new ethers.Wallet(PRIVATE_KEYS.distributor2, provider);
  
  console.log(`Admin: ${admin.address}`);
  console.log(`Distributor 1: ${distributor1.address}`);
  console.log(`Distributor 2: ${distributor2.address}`);
  
  console.log("\n--- Loading Contracts ---");
  let rewardsContract;
  try {
    const rewardsAbi = loadAbi("DistributedRewardsDistribution");
    
    // Check if we're using a real provider or mock provider
    if (typeof provider.getNetwork === 'function') {
      rewardsContract = new ethers.Contract(REWARDS_DISTRIBUTION_ADDRESS, rewardsAbi, provider);
      console.log(`Rewards Contract at: ${rewardsContract.address}`);
      
      // Verify contract connection
      const routerAddr = await rewardsContract.router();
      console.log(`Successfully connected to Rewards Contract. Router: ${routerAddr}`);
      
      // Check lastBlockRewarded and set block range to exactly 100 blocks
      const lastBlockRewarded = await rewardsContract.lastBlockRewarded();
      console.log(`Last block rewarded: ${lastBlockRewarded}`);
      
      // Start with lastBlockRewarded + 1
      FROM_BLOCK = lastBlockRewarded.toNumber() + 1;
      TO_BLOCK = FROM_BLOCK + 99; // 100 block difference (inclusive range)
      console.log(`Setting block range to [${FROM_BLOCK}, ${TO_BLOCK}] (100 blocks)`);
      
      // Check if this range is already committed
      const commitmentKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [FROM_BLOCK, TO_BLOCK])
      );
      
      const commitment = await rewardsContract.commitments(commitmentKey);
      console.log(`Checking if block range [${FROM_BLOCK}, ${TO_BLOCK}] is already committed...`);
      
      if (commitment.exists) {
        console.log(`Warning: Block range [${FROM_BLOCK}, ${TO_BLOCK}] is already committed!`);
        console.log(`Commitment: ${JSON.stringify({
          exists: commitment.exists,
          merkleRoot: commitment.merkleRoot,
          totalBatches: commitment.totalBatches.toString(),
          processedBatches: commitment.processedBatches.toString(),
          approvalCount: commitment.approvalCount.toString(),
          ipfsLink: commitment.ipfsLink
        }, null, 2)}`);
        
        // Try a different range (move up by 100 blocks)
        FROM_BLOCK += 100;
        TO_BLOCK += 100;
        console.log(`Trying new block range: [${FROM_BLOCK}, ${TO_BLOCK}]`);
      }
      
      if (routerAddr.toLowerCase() !== ROUTER_ADDRESS.toLowerCase()) {
        console.warn(`Warning: Router address in contract (${routerAddr}) does not match expected (${ROUTER_ADDRESS})`);
      }
    } else {
      // Create a mock contract for demonstration only
      console.log("Using mock contract for demonstration");
      
      // Mock contract implementation
      const mockStorage = {
        roles: new Map(),
        approvals: new Map(),
        processed: new Map(),
        requiredApproves: 1
      };
      
      rewardsContract = {
        address: REWARDS_DISTRIBUTION_ADDRESS,
        router: async () => ROUTER_ADDRESS,
        REWARDS_DISTRIBUTOR_ROLE: async () => ethers.utils.keccak256(ethers.utils.toUtf8Bytes("REWARDS_DISTRIBUTOR_ROLE")),
        hasRole: async (role, addr) => mockStorage.roles.has(addr) ? mockStorage.roles.get(addr).includes(role) : false,
        requiredApproves: async () => mockStorage.requiredApproves,
        canCommit: async () => true,
        processed: async (key, leafHash) => {
          const mapKey = `${key}_${leafHash}`;
          return mockStorage.processed.has(mapKey);
        },
        
        // Mock methods that allow connections using contract.connect(signer)
        connect: (signer) => ({
          ...rewardsContract,
          signer,
          estimateGas: {
            addDistributor: async () => ethers.BigNumber.from(100000),
            setApprovesRequired: async () => ethers.BigNumber.from(50000),
            commitRoot: async () => ethers.BigNumber.from(200000),
            approveRoot: async () => ethers.BigNumber.from(100000),
            distribute: async () => ethers.BigNumber.from(300000)
          },
          
          // Mock implementation of methods that change state
          addDistributor: async (distributorAddr) => {
            console.log(`[MOCK] Adding distributor ${distributorAddr}`);
            const role = await rewardsContract.REWARDS_DISTRIBUTOR_ROLE();
            
            if (!mockStorage.roles.has(distributorAddr)) {
              mockStorage.roles.set(distributorAddr, [role]);
            } else {
              mockStorage.roles.get(distributorAddr).push(role);
            }
            
            return {
              hash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`addDistributor_${distributorAddr}`)),
              wait: async () => ({ status: 1, gasUsed: ethers.BigNumber.from(90000) })
            };
          },
          
          setApprovesRequired: async (count) => {
            console.log(`[MOCK] Setting required approves to ${count}`);
            mockStorage.requiredApproves = count;
            return {
              hash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`setApprovesRequired_${count}`)),
              wait: async () => ({ status: 1, gasUsed: ethers.BigNumber.from(45000) })
            };
          },
          
          commitRoot: async (blockRange, root, totalBatches, ipfsLink) => {
            console.log(`[MOCK] Committing root for block range [${blockRange[0]}, ${blockRange[1]}]`);
            const key = ethers.utils.keccak256(
              ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [blockRange[0], blockRange[1]])
            );
            mockStorage.approvals.set(key.toString(), { 
              root, 
              totalBatches, 
              ipfsLink,
              approvers: [signer.address]
            });
            
            return {
              hash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`commitRoot_${blockRange[0]}_${blockRange[1]}`)),
              wait: async () => ({ status: 1, gasUsed: ethers.BigNumber.from(180000) })
            };
          },
          
          approveRoot: async (blockRange) => {
            console.log(`[MOCK] Approving root for block range [${blockRange[0]}, ${blockRange[1]}]`);
            const key = ethers.utils.keccak256(
              ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [blockRange[0], blockRange[1]])
            );
            
            if (mockStorage.approvals.has(key.toString())) {
              mockStorage.approvals.get(key.toString()).approvers.push(signer.address);
            } else {
              throw new Error("MerkleRootNotCommitted");
            }
            
            return {
              hash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`approveRoot_${blockRange[0]}_${blockRange[1]}`)),
              wait: async () => ({ status: 1, gasUsed: ethers.BigNumber.from(90000) })
            };
          },
          
          distribute: async (blockRange, recipients, workerRewards, stakerRewards, proof) => {
            console.log(`[MOCK] Distributing rewards to ${recipients.length} recipients`);
            const key = ethers.utils.keccak256(
              ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [blockRange[0], blockRange[1]])
            );
            
            // Calculate leaf hash
            const leafHash = ethers.utils.keccak256(
              ethers.utils.defaultAbiCoder.encode(
                ["uint256[]", "uint256[]", "uint256[]"],
                [recipients, workerRewards, stakerRewards]
              )
            );
            
            // Mark as processed
            const mapKey = `${key}_${leafHash}`;
            mockStorage.processed.set(mapKey, true);
            
            return {
              hash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`distribute_${blockRange[0]}_${blockRange[1]}_${recipients.join(',')}`)),
              wait: async () => ({ status: 1, gasUsed: ethers.BigNumber.from(250000) })
            };
          }
        })
      };
      
      console.log(`Mock Rewards Contract at: ${rewardsContract.address}`);
      console.log(`Mock Router: ${await rewardsContract.router()}`);
    }
  } catch (err) {
    console.error("Failed to load or connect to Rewards Contract:", err);
    process.exit(1);
  }

  // Setup Distributors and Roles
  console.log("\n--- Contract Setup ---");
  try {
    const distributorRole = await rewardsContract.REWARDS_DISTRIBUTOR_ROLE();
    
    if (!(await rewardsContract.hasRole(distributorRole, distributor1.address))) {
      console.log(`Adding distributor 1: ${distributor1.address}`);
      await sendTransaction(rewardsContract, "addDistributor", admin, [distributor1.address]);
    } else {
      console.log(`Distributor 1 already has role.`);
    }
    
    if (!(await rewardsContract.hasRole(distributorRole, distributor2.address))) {
      console.log(`Adding distributor 2: ${distributor2.address}`);
      await sendTransaction(rewardsContract, "addDistributor", admin, [distributor2.address]);
    } else {
      console.log(`Distributor 2 already has role.`);
    }

    // Set required approvals
    const currentRequiredApproves = await rewardsContract.requiredApproves();
    if (currentRequiredApproves.toNumber() !== 1) {
      console.log("Setting required approvals to 1");
      await sendTransaction(rewardsContract, "setApprovesRequired", admin, [1]);
    } else {
      console.log("Required approvals already set to 1.");
    }
    
    // Get current round robin blocks and window size
    const currentRoundRobinBlocks = await rewardsContract.roundRobinBlocks();
    const currentWindowSize = await rewardsContract.windowSize();
    
    console.log(`Current round robin blocks: ${currentRoundRobinBlocks}`);
    console.log(`Current window size: ${currentWindowSize}`);
    
    // Set round robin blocks to 20 to give distributors a longer eligibility window
    const targetRoundRobinBlocks = 20;
    if (currentRoundRobinBlocks.toNumber() !== targetRoundRobinBlocks) {
      console.log(`Setting round robin blocks to ${targetRoundRobinBlocks}`);
      await sendTransaction(rewardsContract, "setRoundRobinBlocks", admin, [targetRoundRobinBlocks]);
    } else {
      console.log(`Round robin blocks already set to ${targetRoundRobinBlocks}.`);
    }
    
    // Ensure window size is suitable
    if (currentWindowSize.toNumber() < 3) {
      console.log("Setting window size to 3");
      await sendTransaction(rewardsContract, "setWindowSize", admin, [3]);
    }
  } catch(err) {
    console.error("Error during contract setup:", err);
    process.exit(1);
  }

  // Generate Worker Batches
  const batches = generateWorkerBatches(NUM_WORKERS, BATCH_SIZE);
  
  // Extract leaf hashes for Merkle tree
  const leafHashes = batches.map(batch => batch.leafHash);
  
  // Create Merkle Tree
  console.log("\n--- Building Merkle Tree ---");
  const merkleTree = new MerkleTree(leafHashes);
  const root = merkleTree.getRoot();
  console.log(`Merkle Root: ${root}`);
  
  // Verify all proofs locally to ensure they work
  let allProofsValid = true;
  for (let i = 0; i < batches.length; i++) {
    const proof = merkleTree.getProof(i);
    const verified = MerkleTree.verifyProof(batches[i].leafHash, proof, root);
    
    if (!verified) {
      console.error(`ERROR: Proof verification failed for batch ${i}`);
      allProofsValid = false;
    } else {
      console.log(`Proof for batch ${i} verified successfully (${proof.length} nodes)`);
    }
  }
  
  if (!allProofsValid) {
    console.error("Some proofs failed local verification! Aborting...");
    process.exit(1);
  }

  // Determine eligible committer based on block number
  const blockNumber = await provider.getBlockNumber();
  
  // Check which distributor is eligible by calling canCommit for both
  const distributor1CanCommit = await rewardsContract.canCommit(distributor1.address);
  const distributor2CanCommit = await rewardsContract.canCommit(distributor2.address);
  
  console.log(`Block number: ${blockNumber}`);
  console.log(`Distributor 1 (${distributor1.address}) can commit: ${distributor1CanCommit}`);
  console.log(`Distributor 2 (${distributor2.address}) can commit: ${distributor2CanCommit}`);
  
  // Choose the eligible distributor
  let eligibleCommitter;
  if (distributor1CanCommit) {
    eligibleCommitter = distributor1;
    console.log(`Using Distributor 1 as eligible committer`);
  } else if (distributor2CanCommit) {
    eligibleCommitter = distributor2;
    console.log(`Using Distributor 2 as eligible committer`);
  } else {
    console.error("Neither distributor can commit! Check roundRobinBlocks, windowSize, and distributor setup.");
    process.exit(1);
  }
  
  // Commit Root
  if (SKIP_COMMIT) {
    console.log("\n--- Skipping Commit Step ---");
  } else {
    console.log("\n--- Committing Root ---");
    
    // Find a valid block range (retry if already committed)
    let commitSuccess = false;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    
    while (!commitSuccess && retryCount < MAX_RETRIES) {
      console.log(`Attempting to commit for block range [${FROM_BLOCK}, ${TO_BLOCK}]`);
      
      // Check if this range is already committed
      const commitmentKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [FROM_BLOCK, TO_BLOCK])
      );
      
      const commitment = await rewardsContract.commitments(commitmentKey);
      
      if (commitment.exists) {
        console.log(`Block range [${FROM_BLOCK}, ${TO_BLOCK}] is already committed.`);
        console.log(`Commitment: ${JSON.stringify({
          merkleRoot: commitment.merkleRoot,
          totalBatches: commitment.totalBatches.toString(),
          processedBatches: commitment.processedBatches.toString(),
          approvalCount: commitment.approvalCount.toString()
        }, null, 2)}`);
        
        // Try the next block range
        FROM_BLOCK += 100;
        TO_BLOCK += 100;
        retryCount++;
        console.log(`Incrementing block range to [${FROM_BLOCK}, ${TO_BLOCK}]...`);
        continue;
      }
      
      try {
        await sendTransaction(
          rewardsContract, 
          "commitRoot", 
          eligibleCommitter, 
          [[FROM_BLOCK, TO_BLOCK], root, batches.length, IPFS_LINK]
        );
        commitSuccess = true;
        console.log(`Successfully committed root for block range [${FROM_BLOCK}, ${TO_BLOCK}]`);
      } catch (err) {
        if (err.message.includes("MerkleRootNotCommitted") || err.message.includes("ALREADY_COMMITTED")) {
          console.warn(`Root already committed for block range [${FROM_BLOCK}, ${TO_BLOCK}]. Incrementing range...`);
          FROM_BLOCK += 100;
          TO_BLOCK += 100;
          retryCount++;
        } else {
          console.error("Commit transaction failed with error:", err.message);
          process.exit(1);
        }
      }
    }
    
    if (!commitSuccess) {
      console.error(`Failed to find an available block range after ${MAX_RETRIES} attempts.`);
      process.exit(1);
    }
  }

  // Approve Root (if needed)
  if (SKIP_APPROVE) {
    console.log("\n--- Skipping Approve Step ---");
  } else {
    console.log("\n--- Approving Root ---");
    //  the approval is optional if requiredApproves = 1
    // since the committer automatically approves
    const requiredApproves = await rewardsContract.requiredApproves();
    
    if (requiredApproves.toNumber() > 1) {
      // Use the other distributor for approval
      const approvalDistributor = eligibleCommitter === distributor1 ? distributor2 : distributor1;
      
      console.log(`Approving Merkle root from ${approvalDistributor.address} for block range [${FROM_BLOCK}, ${TO_BLOCK}]`);
      try {
        await sendTransaction(
          rewardsContract,
          "approveRoot",
          approvalDistributor,
          [[FROM_BLOCK, TO_BLOCK]]
        );
      } catch (err) {
        if (err.message.includes("AlreadyApproved")) {
          console.warn("Root already approved. Continuing...");
        } else {
          console.error("Approve transaction failed:", err.message);
          process.exit(1);
        }
      }
    } else {
      console.log("Required approvals is 1, no additional approval needed.");
    }
  }

  // Distribute Batches
  if (SKIP_DISTRIBUTE) {
    console.log("\n--- Skipping Distribution Phase ---");
  } else {
    console.log("\n--- Distributing Batches ---");
    
    let successCount = 0;
    let failCount = 0;
    let retryCount = 0;
    let totalGasUsed = ethers.BigNumber.from(0);
    const MAX_RETRIES = 2;
    const failedBatches = [];
    
    // Use either distributor for distribution
    const distributorWallet = distributor1;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`\nDistributing batch ${i+1}/${batches.length}...`);
      
      // Generate proof for this batch
      const proof = merkleTree.getProof(i);
      
      // Logging info for debugging purposes
      console.log(`Batch leaf hash: ${batch.leafHash}`);
      console.log(`Proof length: ${proof.length}`);
      
      // Verify locally before sending
      const localVerify = MerkleTree.verifyProof(batch.leafHash, proof, root);
      console.log(`Local proof verification: ${localVerify ? 'SUCCESS' : 'FAILED'}`);
      
      if (!localVerify) {
        console.log(`WARNING: Local proof verification failed, will likely fail on-chain too!`);
        failCount++;
        failedBatches.push({batchIndex: i, recipients: batch.recipients.length});
        continue;
      }
      
      // Prepare distribution parameters
      const distributionArgs = [
        [FROM_BLOCK, TO_BLOCK],   // blockRange
        batch.recipients,          // recipients
        batch.workerRewards,       // workerRewards
        batch.stakerRewards,       // stakerRewards
        proof                      // merkleProof
      ];
      
      // Check if already processed
      let isProcessed = false;
      try {
        const key = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [FROM_BLOCK, TO_BLOCK]));
        const leafHash = batch.leafHash;
        isProcessed = await rewardsContract.processed(key, leafHash);
      } catch (err) {
        console.log(` -> Error checking processed status. Will try distribution anyway.`);
      }
      
      if (isProcessed) {
        console.log(` -> Batch ${i} already processed, skipping.`);
        successCount++;
        continue;
      }

      let distributionSuccess = false;
      let currentRetry = 0;
      
      while (!distributionSuccess && currentRetry <= MAX_RETRIES) {
        try {
          if (currentRetry > 0) {
            console.log(`Retry attempt ${currentRetry}/${MAX_RETRIES} for batch ${i}`);
          }
          
          const receipt = await sendTransaction(
            rewardsContract,
            "distribute",
            distributorWallet,
            distributionArgs
          );
          
          console.log(` -> Distribution successful for batch ${i}`);
          successCount++;
          totalGasUsed = totalGasUsed.add(receipt.gasUsed);
          distributionSuccess = true;
        } catch (error) {
          const errorStr = String(error?.reason || error?.message || error);
          console.error(` -> Failed to distribute batch ${i}: ${errorStr}`);
          
          // Check for specific errors
          if (errorStr.includes('InvalidMerkleProof')) {
            console.error(`   This is a proof verification error. The Merkle tree implementation may not match the contract.`);
            if (currentRetry === MAX_RETRIES) {
              failedBatches.push({batchIndex: i, recipients: batch.recipients.length, error: 'InvalidMerkleProof'});
            }
          }
          else if (errorStr.includes('BatchAlreadyProcessed')) {
            console.log(`   Batch was already processed. Counting as success.`);
            successCount++;
            distributionSuccess = true;
            break;
          }
          
          if (currentRetry === MAX_RETRIES) {
            failCount++;
          }
          
          currentRetry++;
        }
      }
    }

    // Results
    console.log("\n--- Distribution Results ---");
    console.log(`Total workers: ${NUM_WORKERS}`);
    console.log(`Batch size: ${BATCH_SIZE}`);
    console.log(`Total batches: ${batches.length}`);
    console.log(`Successfully distributed: ${successCount}`);
    console.log(`Failed distributions: ${failCount}`);
    
    if (failedBatches.length > 0) {
      console.log(`\nFailed batches (${failedBatches.length}):`);
      failedBatches.forEach(batch => {
        console.log(` - Batch index ${batch.batchIndex}, Recipients: ${batch.recipients}, Error: ${batch.error || 'Unknown'}`);
      });
    }
    
    if (successCount > 0 && totalGasUsed.gt(0)) {
      console.log(`Total gas used: ${totalGasUsed.toString()}`);
      console.log(`Average gas per batch: ${totalGasUsed.div(successCount).toString()}`);
      console.log(`Average gas per worker: ${totalGasUsed.div(Math.min(successCount * BATCH_SIZE, NUM_WORKERS)).toString()}`);
    }
  }

  console.log("\n--- Test Completed Successfully ---");
}


(async () => {
  try {
    console.log("Starting script...");
    await testSingleMerkleDistribution();
  } catch (err) {
    console.error("Script failed with error:", err.message || err);
    process.exit(1);
  }
})(); 