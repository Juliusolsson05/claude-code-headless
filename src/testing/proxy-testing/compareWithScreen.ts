export type ComparisonSnapshot = {
  proxyText: string
  screenText: string
}

export function summarizeComparison(snapshot: ComparisonSnapshot): string {
  const proxyLen = snapshot.proxyText.length
  const screenLen = snapshot.screenText.length
  const identical = snapshot.proxyText === snapshot.screenText

  return [
    `proxy chars: ${proxyLen}`,
    `screen chars: ${screenLen}`,
    `identical: ${identical ? 'yes' : 'no'}`,
  ].join('\n')
}
