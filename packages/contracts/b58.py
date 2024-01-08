import base58
import sys

print(base58.b58decode(sys.argv[1]).hex())
