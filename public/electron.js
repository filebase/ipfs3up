const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron')
const isDev = require('electron-is-dev')
const path = require('path')
const { filesFromPath } = require('files-from-path')
const { FilebaseClient } = require('@filebase/client')
const Store = require('electron-store')
const fs = require('fs')

function createWindow () {
  const store = new Store({ schema: { apiToken: { type: 'string' } } })

  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    ...isDev ? [{ role: 'viewMenu' }] : [],
    {
      label: 'Tools',
      submenu: [{
        id: 'clear-api-token',
        label: 'Clear API Token',
        click: () => store.set('apiSecret', ''),
        enabled: true
      }]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: () => shell.openExternal('https:/filebase.com')
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  const mainWindow = new BrowserWindow({
    title: 'IPFS3 UP',
    width: 880,
    height: 420,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  // mainWindow.setMenu(null)

  mainWindow.loadURL(isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '..', 'build', 'index.html')}`)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // mainWindow.webContents.openDevTools()

  ipcMain.handle('setApiCredentials', (_, {
    key,
    secret,
    bucket
  }) => {
    store.set('apiKey', key)
    store.set('apiSecret', secret)
    store.set('apiBucket', bucket)
  })
  ipcMain.handle('setApiToken', (_, token) => store.set('apiSecret', token))
  ipcMain.handle('hasApiToken', () => Boolean(store.get('apiSecret')))

  const sendUploadProgress = p => mainWindow.webContents.send('uploadProgress', p)

  ipcMain.on('uploadFiles', async (event, paths) => {
    /** @type {string} */
    const secretAccessKey = store.get('apiSecret')
    if (!secretAccessKey) {
      return sendUploadProgress({ error: 'missing secret' })
    }

    const accessKeyId = store.get('apiKey')
    if (!accessKeyId) {
      return sendUploadProgress({ error: 'missing key' })
    }

    const bucketForUpload = store.get('apiBucket');
    if (!bucketForUpload) {
      return sendUploadProgress({ error: 'missing bucket' })
    }

    try {
      mainWindow.setProgressBar(2)
      sendUploadProgress({ statusText: 'Reading files...' })
      let totalBytes = 0
      const files = []
      let objectName;
      try {
        let pathPrefix
        // if a single directory, yield files without the directory name in them
        if (paths.length === 1 && (await fs.promises.stat(paths[0])).isDirectory) {
          pathPrefix = paths[0]
        }

        // set directory name as object name
        const filePath = paths[0];
        let pathToImport;
        if (!objectName) {
          pathToImport = path.dirname(filePath);
          objectName = path.basename(pathToImport);
          pathPrefix = pathToImport;
        }

        for await (const file of filesFromPath(pathToImport, {
          pathPrefix,
          hidden: true,
          followSymlinks: true
        })) {
          files.push(file)
          totalBytes += file.size
          sendUploadProgress({ totalBytes, totalFiles: files.length })
        }
      } catch (err) {
        console.error(err)
        return sendUploadProgress({ error: `reading files: ${err.message}` })
      }

      sendUploadProgress({ statusText: 'Packing files...' })
      let cid, car
      try {
        ;({ cid, car } = files.length === 1 && paths[0].endsWith(files[0].name)
          ? await FilebaseClient.encodeBlob(files[0])
          : await FilebaseClient.encodeDirectory(files))
      } catch (err) {
        console.error(err)
        return sendUploadProgress({ error: `packing files: ${err.message}` })
      }

      try {
        let storedChunks = 0
        let storedBytes = 0.01
        sendUploadProgress({ statusText: 'Storing files...', storedChunks, storedBytes })
        sendUploadProgress({ bucket: bucketForUpload, objectName: objectName })
        await FilebaseClient.storeCar(
          { endpoint: 'https://s3.filebase.com', token: btoa(`${accessKeyId}:${secretAccessKey}:${bucketForUpload}`) },
          car,
          objectName || cid.toString(),
          {
            onStoredChunk (size) {
              storedChunks++
              storedBytes += size
              sendUploadProgress({ storedBytes, storedChunks })
              mainWindow.setProgressBar(storedBytes / totalBytes)
              if (storedBytes > totalBytes) {
                sendUploadProgress({statusText: 'Processing upload...'})
              }
            },
            onComplete () {
              return sendUploadProgress({statusText: 'Processing upload...'})
            }
          }
        )
      } catch (err) {
        console.error(err)
        return sendUploadProgress({ error: `storing files: ${err.message}` })
      } finally {
        if (car && car.blockstore && car.blockstore.close) {
          car.blockstore.close()
        }
      }

      sendUploadProgress({ cid: cid.toString(), storedBytes: totalBytes, statusText: 'Done!' })
    } finally {
      mainWindow.setProgressBar(-1)
    }
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  // if (process.platform !== 'darwin') app.quit()
  app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
