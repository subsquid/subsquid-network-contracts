import dayjs from "dayjs";
import fs from "fs";

const workersCount = Number(process.argv[2] ?? 10)
const epochLength = Number(process.argv[3] ?? 86400)

const DAY = 24 * 60 * 60 * 1000
const PING_INTERVAL = 50_000
const BACK_ONLINE_PROBABILITY = 0.7
const WORK_START = new Date('2023-07-11')

const randomLetter = () => Math.random().toString(36)[2]

// Make fake peerIds easily distinguishable by using repeating characters
const randomPeerId = () => `12D3KooWM${randomLetter().repeat(41)}${randomLetter()}${randomLetter()}`

function randomBoxMueller(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); //Converting [0,1) to (0,1)
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5; // Translate to 0 -> 1
  if (num > 1 || num < 0) return randomBoxMueller() // resample between 0 and 1
  return num
}

// Chance that the worker will stop sanding pings this time
// After first ping missed, chance of next missed ping is {BACK_ONLINE_PROBABILITY}
// When first ping is sent, worker is back online
const offlineProbabilityPercentage = () => Math.exp(Math.random() * 3 - 1)

const generateWorkers = () => {
  const nodes = []
  for (let i = 0; i < workersCount; i++) {
    nodes.push({
      workerId: randomPeerId(),
      offlineProbability: offlineProbabilityPercentage(),
      workStartDelay: Math.floor(Math.random() * DAY * 10)
    })
  }
  return nodes
}

type Workers = ReturnType<typeof generateWorkers>


fs.writeFileSync('pings.csv', 'timestamp,workerId\n')

function printPing(worker: string, timestamp: number) {
  fs.appendFileSync('pings.csv', `${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')},${worker}\n`)
}

const generatePings = (workers: Workers) => {
  const isOffline: { [key in string]: boolean } = {}
  const startTimestamp = WORK_START.getTime()
  const now = Date.now()
  for (let i = 0; i + startTimestamp < now; i += PING_INTERVAL) {
    for (const worker of workers) {
      if (worker.workStartDelay > i) continue
      if (isOffline[worker.workerId]) {
        isOffline[worker.workerId] = Math.random() < BACK_ONLINE_PROBABILITY
      } else {
        isOffline[worker.workerId] = Math.random() * 100 < worker.offlineProbability
      }
      if (!isOffline[worker.workerId]) {
        printPing(worker.workerId, startTimestamp + i)
      }
    }
  }
  console.log('Pings generated')
}

const generateQueries = (workers: Workers) => {
  const queries = []
  const startTimestamp = WORK_START.getTime()
  const now = Date.now()
  for (const worker of workers) {
    let time = worker.workStartDelay
    const responseBytes = Math.floor(randomBoxMueller() * 10_000)
    const chunks = Math.max(1, Math.floor(responseBytes / 1000 + Math.random() * 8 - 4))
    while (time < now) {
      queries.push({
        workerId: worker.workerId,
        timestamp: time,
        responseBytes,
        chunks,
      })
      time += Math.floor(randomBoxMueller() * 1000 * 60 * 60 * 10)
    }
    console.log('Queries generated for worker', worker.workerId)
  }
  queries.sort((a, b) => a.timestamp - b.timestamp)
  fs.writeFileSync('queries.csv', 'timestamp,workerId,readChunks,responseBytes\n')
  fs.appendFileSync('queries.csv', queries.map(({timestamp, workerId, responseBytes, chunks}) => `${dayjs(timestamp + startTimestamp).format('YYYY-MM-DD HH:mm:ss')},${workerId},${chunks},${responseBytes}`).join('\n'))
}

const workers = generateWorkers()
console.table(workers)
generatePings(workers)
generateQueries(workers)
