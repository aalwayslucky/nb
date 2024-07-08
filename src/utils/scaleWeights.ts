type CalculateWeightsParams = {
  fromScale: number;
  toScale: number;
  orders: number;
};

export function calculateWeights({
  fromScale,
  toScale,
  orders,
}: CalculateWeightsParams): number {
  const totalWeight = ((toScale + fromScale) / 2) * orders;
  return totalWeight;
}
interface CalcValidOrdersCountOptions {
  fromScale: number;
  toScale: number;
  orders: number;
  amount: number;
  minSize: number;
  minNotional: number;
  totalWeight: number;
  fromPrice: number;
}
export function calcValidOrdersCount(
  opts: CalcValidOrdersCountOptions
): number {
  let validOrdersCount = 0;
  const {
    fromScale,
    toScale,
    orders,
    amount,
    minSize,
    minNotional,
    totalWeight,
    fromPrice,
  } = opts;
  for (let i = 0; i < orders; i++) {
    const weightOfOrder =
      fromScale + (toScale - fromScale) * (i / (orders - 1));
    const sizeOfOrder = amount * (weightOfOrder / totalWeight);
    if (sizeOfOrder > minSize && sizeOfOrder * fromPrice > minNotional) {
      validOrdersCount++;
    }
  }

  return validOrdersCount;
}
