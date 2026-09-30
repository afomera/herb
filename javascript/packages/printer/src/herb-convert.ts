#!/usr/bin/env node

import { ConvertCLI } from "./convert-cli.js"

new ConvertCLI().run().then(code => process.exit(code))
