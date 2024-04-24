import protobuf from "protobufjs";
import path from "path";
import { peerIdFromString } from "@libp2p/peer-id";
import { fileURLToPath } from "url";
import { keys } from "@libp2p/crypto";

export interface QueryLog {
  client_id: string;
  worker_id: string;
  query_id: string;
  dataset: string;
  query: string;
  profiling: boolean;
  client_state_json: string;
  query_hash: string;
  exec_time_ms: number;
  result: number;
  num_read_chunks: number;
  output_size: number;
  output_hash: string;
  error_msg: string;
  seq_no: number;
  client_signature: string;
  worker_signature: string;
  worker_timestamp: number;
  collector_timestamp: number;
}

async function loadProto(type: "Query" | "QueryExecuted") {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const proto = await protobuf.load(
    path.resolve(__dirname, "protobuf/query.proto"),
  );
  return proto.lookupType(type);
}

function queryPayload(queryLog: QueryLog, signature?: string) {
  const signatureInBytes = signature
    ? Buffer.from(signature, "hex")
    : undefined;
  return {
    queryId: queryLog.query_id,
    dataset: queryLog.dataset,
    query: queryLog.query,
    profiling: queryLog.profiling,
    clientStateJson: queryLog.client_state_json,
    signature: signatureInBytes,
  };
}

export async function populateQueryProto(queryLog: QueryLog) {
  const Query = await loadProto("Query");
  const payload = queryPayload(queryLog);
  const err = Query.verify(payload);
  if (err) {
    throw Error(err);
  }
  return Query.encode(payload).finish();
}

function queryResult(queryLog: QueryLog) {
  if (queryLog.error_msg) {
    return {
      badRequest: queryLog.error_msg,
    };
  }
  return {
    ok: {
      numReadChunks: queryLog.num_read_chunks,
      output: {
        size: queryLog.output_size,
        sha3_256: Buffer.from(queryLog.output_hash, "hex"),
      },
    },
  };
}

function queryExecutedPayload(queryLog: QueryLog, clientSignature: string) {
  return {
    clientId: queryLog.client_id,
    workerId: queryLog.worker_id,
    query: queryPayload(queryLog, clientSignature),
    queryHash: Buffer.from(queryLog.query_hash, "hex"),
    execTimeMs: queryLog.exec_time_ms,
    ...queryResult(queryLog),
    seqNo: queryLog.seq_no,
    timestampMs: queryLog.worker_timestamp,
  };
}

export async function populateQueryExecuted(
  queryLog: QueryLog,
  clientSignature: string,
) {
  const QueryExecuted = await loadProto("QueryExecuted");
  const payload = queryExecutedPayload(queryLog, clientSignature);
  const err = QueryExecuted.verify(payload);
  if (err) {
    throw Error(err);
  }
  return QueryExecuted.encode(payload).finish();
}

export function verifySignature(
  message: Uint8Array,
  signature: string,
  peerId: string,
) {
  const publicKey = keys.unmarshalPublicKey(
    peerIdFromString(peerId).publicKey!,
  );
  return publicKey.verify(message, Buffer.from(signature, "hex"));
}

export async function validateSignatures(queryLog: QueryLog) {
  const query = await populateQueryProto(queryLog);
  const clientSignature = queryLog.client_signature;
  if (!verifySignature(query, clientSignature, queryLog.client_id)) {
    return false;
  }
  const queryExecuted = await populateQueryExecuted(queryLog, clientSignature);
  const workerSignature = queryLog.worker_signature;
  return verifySignature(queryExecuted, workerSignature, queryLog.worker_id);
}
