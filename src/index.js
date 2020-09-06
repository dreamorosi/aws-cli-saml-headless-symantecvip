const path = require('path')
const puppeteer = require('puppeteer')
require('dotenv').config()
const assert = require('assert')
const inquirer = require('inquirer');
const { STS } = require('@aws-sdk/client-sts');
const { exit } = require('process')

// Support for pkg
const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (process.pkg
        ? path.join(
            path.dirname(process.execPath),
            'puppeteer',
            ...puppeteer
                .executablePath()
                .split(path.sep)
                .slice(6), // /snapshot/project/node_modules/puppeteer/.local-chromium
        )
        : puppeteer.executablePath());

const getUserInfo = async () => {
    // TODO: proper logging
    // const os = require("os");
    // TODO: add support for command line input if previous two not present
    return {
        email: process.env.EMAIL,
        pass: process.env.PASS,
        federationUrl: process.env.URL,
        idpName: process.env.IDPNAME
    }
}

const getSAMLnRoles = async (email, pass, url) => {
    // TODO: proper logging
    // Init a new browser
    const browser = await puppeteer.launch({
        executablePath: executablePath,
        args: [
            // Required for Docker version of Puppeteer
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // This will write shared memory files into /tmp instead of /dev/shm,
            // because Docker’s default for /dev/shm is 64MB
            // '--disable-dev-shm-usage'
        ]
    })


    // Open new tab & attempt login (will redirect to Symantec VIP login form).
    let page = await browser.newPage()
    const response = await page.goto(url)

    // Make sure correct page is loaded.
    assert(response.ok())
    // TODO: add more checks.

    // Fill auth form and submit.
    await page.type('#userNameInput', email);
    await page.type('#passwordInput', pass);
    await page.click('#submitButton');
    // TODO: account for wrong credentials

    // Wait for login to be verified and second page to appear.
    await page.waitFor('#vipSkipBtn');
    await page.click('#vipSkipBtn');

    // Wait for AWS SAML Login page to appear.
    await page.waitFor('#saml_form')

    // Get SAML Response from page.
    let saml
    try {
        const samlEl = await page.$('#saml_form input[name="SAMLResponse"]')
        saml = await (await samlEl.getProperty('value')).jsonValue()
        console.log('Saml Token OK')
    } catch (error) {
        console.error(err);
        console.error('Unable to retrieve SAML token.')
        exit(1)
    }

    let roles = {}
    try {
        await asyncForEach((await page.$$(`.saml-account[id] .saml-role input.saml-radio`)), async (roleEl) => {
            const arn = await (await roleEl.getProperty('value')).jsonValue();
            const accountId = arn.match(/\d{12}/)
            const name = arn.split('/')[1]
            if (!(accountId in roles)) {
                roles[accountId] = []
            }
            roles[accountId].push({
                name: name,
                arn: arn
            })
        })
    } catch (err) {
        console.error(err);
        console.error('Unable to retrieve IAM roles.')
        exit(1)
    }
    // Dispose of browser.
    await page.close()
    await browser.close()

    return {
        saml: saml,
        roles: roles
    }
}

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

const chooseRole = async (accounts) => {
    // TODO: proper logging
    var prompt = inquirer.createPromptModule();

    // Create choices array.
    let choices = []
    Object.keys(accounts).forEach(account => {
        choices.push(new inquirer.Separator(`-- ${account} --`))
        accounts[account].forEach(role => choices.push(`${role.name} - ${role.arn}`))
    })

    // Prompt user to choose.
    let answer = await prompt({
        type: 'list',
        name: 'role',
        message: 'Choose an IAM Role:',
        choices: choices
    })

    // Extract IAM Role ARN and AWS Account ID.
    const { role } = answer
    let arn = role.split(' - ')[1]
    let account = arn.match(/\d{12}/)[0]

    return {
        roleArn: arn,
        accountId: account
    }
}

const assumeRole = async (chosenRole, saml, idpName) => {
    // TODO: proper logging
    var sts = new STS();
    var params = {
        DurationSeconds: 3600,
        PrincipalArn: `arn:aws:iam::${chosenRole.accountId}:saml-provider/${idpName}`,
        RoleArn: chosenRole.roleArn,
        SAMLAssertion: saml
    };
    try {
        const response = await sts.assumeRoleWithSAML(params)
        const { Credentials: credentials } = response
        return {
            accessKey: credentials.AccessKeyId,
            secretkey: credentials.SecretAccessKey,
            token: credentials.SessionToken,
            expiration: credentials.Expiration
        }
    } catch (err) {
        console.error(err);
        console.error('Unable to assume IAM Role.')
    }
}

(async () => {
    const userInfo = await getUserInfo()
    console.log('Authenticating')
    // TODO: add support for default role; in that case retrieve SAML & verify role existence.
    const { saml, roles } = await getSAMLnRoles(
        userInfo.email,
        userInfo.pass,
        userInfo.federationUrl
    )

    // TODO: check if there is only 1 account & 1 role OR default role is set, in that case skip this step.
    const chosenNole = await chooseRole(roles)

    const credentials = await assumeRole(chosenNole, saml, userInfo.idpName)

    console.log(`aws_access_key_id = ${credentials.accessKey}`)
    console.log(`aws_secret_access_key = ${credentials.secretkey}`)
    console.log(`aws_session_token  = ${credentials.token}`)

    console.log(`Credentials will expire at ${credentials.expiration}`)
})()