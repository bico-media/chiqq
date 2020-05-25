# Chiqq

> High throughput async task pool / queue manager

Internal tool used by http://add.bico.media to manage the flow of creating and distributing files as transactions. 

Documentation coming later, but in short:

**Install**

```
yarn add chiqq

```

**Use**


Run max 5 tasks at the time - try no more than 10 times if it fails with 5 seconds between 1st and 2nd try and doubling the time between each try:

```
import Chiqq from 'chiqq';

let q = new Chiqq({concurrency: 5, retryMax: 10, retryCooling: 5000, retryFactor: 2});

function handleInput(){
  
  // ...
  
  let res = await q.add(async () => {
    return something()
  });
  
  doSOmethingElse(res)
  
  // ...
  
}
```
