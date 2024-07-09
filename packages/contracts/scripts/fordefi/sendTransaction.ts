import * as crypto from "crypto";
import fs from "fs";

const gatewayHost = "api.fordefi.com";

async function waitForFordefiTransaction(id: string) {
  const accessToken = process.env.ACCESS_TOKEN;
  const path = "/api/v1/transactions";

  let timeout = 250;
  while (true) {
    const response = await fetch(`https://${gatewayHost}${path}/${id}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const json = await response.json();
    if (json.hash && json.mined_result?.reversion?.state === "not_reverted") {
      return json.hash;
    }
    if (json.hash && json.mined_result?.reversion?.reason) {
      throw new Error(
        JSON.stringify({
          id: json.hash,
          reason: json.mined_result?.reason,
        }),
      );
    }
    if (timeout >= 30000) {
      throw new Error(`Transaction ${id} timeout`);
    }
    timeout *= 2;
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }
}

export async function sendFordefiTransaction(request: any): Promise<string> {
  const accessToken = process.env.FORDEFI_ACCESS_TOKEN;

  const requestBody = JSON.stringify(request);
  const path = "/api/v1/transactions";
  const privateKeyFile = "./private.pem";
  const timestamp = new Date().getTime();
  const payload = `${path}|${timestamp}|${requestBody}`;

  const secretPem = fs.readFileSync(privateKeyFile, "utf8");
  const privateKey = crypto.createPrivateKey(secretPem);
  const sign = crypto.createSign("SHA256").update(payload, "utf8").end();
  const signature = sign.sign(privateKey, "base64");

  const response = await fetch(`https://${gatewayHost}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-Timestamp": timestamp.toString(),
      "X-Signature": signature,
    },
    body: requestBody,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const { id } = await response.json();
  return id;
}
