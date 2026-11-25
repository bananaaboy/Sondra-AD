import zlib from 'node:zlib'

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

export function buildTrayIconPng(size = 32, active = true) {
  const raw = Buffer.alloc(size * (1 + size * 4), 0)
  const [rCol, gCol, bCol] = active ? [11, 74, 34] : [78, 99, 85]

  const bars = [
    { x0: 0.26, x1: 0.72, y0: 0.16, y1: 0.27 },
    { x0: 0.22, x1: 0.88, y0: 0.31, y1: 0.42 },
    { x0: 0.12, x1: 0.86, y0: 0.46, y1: 0.57 },
    { x0: 0.10, x1: 0.78, y0: 0.61, y1: 0.72 },
    { x0: 0.26, x1: 0.72, y0: 0.76, y1: 0.87 },
  ]

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (1 + size * 4)
    raw[rowOffset] = 0
    const ny = (y + 0.5) / size
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size
      let inside = false
      for (const bar of bars) {
        if (nx >= bar.x0 && nx <= bar.x1 && ny >= bar.y0 && ny <= bar.y1) {
          inside = true
          break
        }
      }
      const px = rowOffset + 1 + x * 4
      if (inside) {
        raw[px] = rCol
        raw[px + 1] = gCol
        raw[px + 2] = bCol
        raw[px + 3] = 255
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
