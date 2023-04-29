import fs from 'fs'

async function exists (name) {
  return new Promise(resolve => fs.exists(name, resolve))
}

async function mkdir (name) {
  if (!await exists(name)) {
    const parts = name.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const branch = parts.slice(0, i).join('/')
      if (!await exists(branch)) {
        await new Promise(resolve => fs.mkdir(branch, resolve))
      }
    }
  }
}

async function listDir (name) {
  if (!await exists(name)) {
    return []
  }
  return await new Promise(resolve => {
    fs.readdir(name, (err, files) => {
      resolve(err ? [] : files)
    })
  })
}

async function write (name, data) {
  return new Promise(resolve => fs.writeFile(name, data, resolve))
}

async function read (name) {
  return await new Promise(resolve => {
    fs.readFile(name, 'utf-8', (err, data) => {
      resolve(err ? null : data)
    })
  })
}

async function remove (name) {
  return await new Promise(resolve => {
    fs.unlink(name, resolve)
  })
}

export async function sleep (ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export const fsUtils = {
  exists,
  mkdir,
  write,
  read,
  remove,
  listDir
}
