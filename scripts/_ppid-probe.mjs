import { execSync } from "node:child_process";
console.log("PARENT:", execSync(`ps -p ${process.ppid} -o command=`).toString().trim());
