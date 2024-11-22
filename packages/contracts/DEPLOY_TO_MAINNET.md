Re-deploy a single contract to the mainnet

Network controller
```bash
forge create src/NetworkController.sol:NetworkController \
  --private-key=$(op read "op://Shared/SQD Contract deployer/password") \
  -r https://arb1.arbitrum.io/rpc \
  --verify \
  --constructor-args 100 19810800 0 100000000000000000000000 "[0x36E2B147Db67E76aB67a4d07C293670EbeFcAE4E,0x237Abf43bc51fd5c50d0D598A1A4c26E56a8A2A0,0xB31a0D39D2C69Ed4B28d96E12cbf52C5f9Ac9a51,0x8A90A1cE5fa8Cf71De9e6f76B7d3c0B72feB8c4b]"
```