// Smooth only the completed indirect result; transport keeps its original samples.
@compute @workgroup_size(64)
fn blurDiffuse(@builtin(global_invocation_id) id:vec3u) {
  let size=i32(params.sky.w);
  if(id.x>=u32(size*size)){return;}
  let pixel=vec2i(i32(id.x)%size,i32(id.x)/size);
  let center=surfaces[id.x];
  if(params.update.w>.5 && (center.position.w==0.0 || center.normal.w<.5)) {
    textureStore(output,pixel,vec4f(0));
    return;
  }
  let light=bounceLight[id.x].total.rgb;
  let luminance=vec3f(.2126,.7152,.0722);
  let brightness=dot(light,luminance);
  var total=light*4.0;
  var weight=4.0;
  if(center.position.w>0.0) {
    for(var y=-1;y<=1;y++) {
      for(var x=-1;x<=1;x++) {
        if(x==0&&y==0){continue;}
        let point=pixel+vec2i(x,y);
        if(any(point<vec2i(0))||any(point>=vec2i(size))){continue;}
        let index=u32(point.y*size+point.x);
        let sample=surfaces[index];
        let delta=sample.position.xyz-center.position.xyz;
        if(sample.position.w==0.0||(params.update.w>.5&&sample.normal.w<.5)||sample.color.w!=center.color.w
          ||dot(sample.normal.xyz,center.normal.xyz)<.995
          ||abs(dot(delta,center.normal.xyz))>.01||dot(delta,delta)>.25){continue;}
        let neighbour=bounceLight[index].total.rgb;
        let difference=(dot(neighbour,luminance)-brightness)/max(.001,brightness*.25);
        let tap=select(1.0,2.0,x==0||y==0)*exp(-.5*difference*difference);
        total+=neighbour*tap;
        weight+=tap;
      }
    }
  }
  textureStore(output,pixel,vec4f(total/weight,1));
}
