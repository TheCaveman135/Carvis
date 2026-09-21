export function encodePcm(chunks, rate, target = 16000) {
  const size=chunks.reduce((n,c)=>n+c.length,0),input=new Float32Array(size);
  let offset=0;for(const chunk of chunks){input.set(chunk,offset);offset+=chunk.length;}
  const count=Math.floor(size*target/rate),buffer=new ArrayBuffer(count*2),view=new DataView(buffer);
  for(let i=0;i<count;i++){
    const position=i*rate/target,index=Math.floor(position),mix=position-index;
    const value=Math.max(-1,Math.min(1,(input[index] || 0)*(1-mix)+(input[Math.min(index+1,size-1)] || 0)*mix));
    view.setInt16(i*2,Math.round(value*(value<0?32768:32767)),true);
  }
  return buffer;
}
