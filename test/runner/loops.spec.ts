// it: should loop over values with long array
{
  const input = Array.from(Array(10000).keys());
  const output = [];
  for (let o of input) {
    // @ts-ignore
    output.push(o);
  }

  input.toString() === output.toString();
}

// it: should correctly throw from loop
{
  const input = [1, 2, 3];
  let result = false;
  try {
    for (let _ of input) {
      throw "error";
    }
  } catch (e) {
    // ignore
    result = true;
  }
  result;
}

// it: should support standard for loop
{
  const result = [];
  for (let i = 0; i < 3; i++) {
    // @ts-ignore
    result.push(i);
  }
  result.toString() === [0, 1, 2].toString();
}
