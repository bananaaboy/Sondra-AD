import qrcode from 'qrcode-generator'

export function createQrMatrix(text: string): { size: number; cells: boolean[][] } | null {
  if (!text) return null
  try {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const size = qr.getModuleCount()
    const cells: boolean[][] = []
    for (let r = 0; r < size; r += 1) {
      const row: boolean[] = []
      for (let c = 0; c < size; c += 1) {
        row.push(qr.isDark(r, c))
      }
      cells.push(row)
    }
    return { size, cells }
  } catch {
    return null
  }
}
