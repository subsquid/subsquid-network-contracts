import { Injectable } from '@nestjs/common';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';


@Injectable()
export class CommitmentKeyService {

  generateKey(fromBlock: number, toBlock: number): `0x${string}` {
    const encoded = encodeAbiParameters(
      parseAbiParameters('uint256, uint256'),
      [BigInt(fromBlock), BigInt(toBlock)],
    );
    return keccak256(encoded);
  }


  generateKeyFromBigInt(fromBlock: bigint, toBlock: bigint): `0x${string}` {
    const encoded = encodeAbiParameters(
      parseAbiParameters('uint256, uint256'),
      [fromBlock, toBlock],
    );
    return keccak256(encoded);
  }
}