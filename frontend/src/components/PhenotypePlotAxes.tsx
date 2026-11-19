import { formatPhenotypeValue } from '../utils/phenotypeMap'

type Props = {
  plot: { left: number; right: number; top: number; bottom: number }
  xDomain: number[]
  yDomain: number[]
  xLabel: string
  yLabel: string
  height: number
  tickCount: number
}

export default function PhenotypePlotAxes({ plot, xDomain, yDomain, xLabel, yLabel, height, tickCount }: Props) {
  const { left, right, top, bottom } = plot
  return (
    <g pointerEvents="none" fill="currentColor">
      {Array.from({ length: tickCount + 1 }, (_, index) => {
        const fraction = index / tickCount
        const x = left + fraction * (right - left)
        const y = bottom - fraction * (bottom - top)
        return (
          <g key={index}>
            <line x1={x} x2={x} y1={top} y2={bottom} stroke="var(--chakra-colors-sand-200)" />
            <line x1={left} x2={right} y1={y} y2={y} stroke="var(--chakra-colors-sand-200)" />
            <text x={x} y={bottom + 24} textAnchor="middle" fontSize="12">
              {formatPhenotypeValue(xDomain[0] + fraction * (xDomain[1] - xDomain[0]))}
            </text>
            <text x={left - 10} y={y + 4} textAnchor="end" fontSize="12">
              {formatPhenotypeValue(yDomain[0] + fraction * (yDomain[1] - yDomain[0]))}
            </text>
          </g>
        )
      })}
      <path d={`M${left},${top}V${bottom}H${right}`} fill="none" stroke="currentColor" />
      <text x={(left + right) / 2} y={height - 12} textAnchor="middle" fontSize="14">{xLabel}</text>
      <text transform={`translate(20 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize="14">{yLabel}</text>
    </g>
  )
}
