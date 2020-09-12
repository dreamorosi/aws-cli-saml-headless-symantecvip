const path = require("path");
const puppeteer = require("puppeteer");
require("dotenv").config();
const assert = require("assert");
const inquirer = require("inquirer");
const { STS } = require("@aws-sdk/client-sts");
const process = require("process");
const util = require("util");
const fs = require("fs");
const ProgressBar = require("progress");
var parseString = util.promisify(require("xml2js").parseString);
const meow = require("meow");
const leven = require("leven");

// Support for pkg
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (process.pkg
    ? path.join(
        path.dirname(process.execPath),
        "puppeteer",
        ...puppeteer.executablePath().split(path.sep).slice(6) // /snapshot/project/node_modules/puppeteer/.local-chromium
      )
    : puppeteer.executablePath());

const getUserInfo = async () => {
  // TODO: proper logging
  // const os = require("os");
  // TODO: add support for command line input with priority 1, then environment vars prio 2, then default/errors 3.
  if (!fs.existsSync(path.join(path.dirname(process.execPath), ".env"))) {
    console.warn(
      `No .env file found, unable to retrieve configurations.
      Please create one at ${path.join(
        path.dirname(process.execPath)
      )} as explained in the README.`
    );
    process.exit(1);
  }
  return {
    email: process.env.EMAIL,
    pass: process.env.PASS,
    federationUrl: process.env.URL,
    durationSeconds: parseInt(process.env.DURATION_SECONDS),
  };
};

const getSAMLResponse = async (email, pass, url) => {
  // TODO: proper logging - convert all the console.err to debug when verbose + add additional verbosity for success
  // Start a browser and open a tab.
  let browser;
  let page;
  try {
    browser = await puppeteer.launch({
      executablePath: executablePath,
      args: [
        // Required for Docker version of Puppeteer
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // This will write shared memory files into /tmp instead of /dev/shm,
        // because Docker’s default for /dev/shm is 64MB
        // '--disable-dev-shm-usage'
      ],
    });
    page = await browser.newPage();
  } catch (err) {
    console.error(err);
    console.error("Unable to start Chromium headless browser.");
    process.exit(1);
  }

  console.log("Sending Push notification - Get your phone ready!");

  // Navigate to the AWS page, this will redirect to the SymantecVIP login page of the org.
  try {
    const response = await page.goto(url);
    assert(response.ok());
  } catch (err) {
    console.error(err);
    console.error(`Unable to navigate to ${url}.`);
    process.exit(1);
  }

  // TODO: account for wrong credentials + allow selectors customization
  // Fill login form
  try {
    await page.type("#userNameInput", email);
    await page.type("#passwordInput", pass);
    await page.click("#submitButton");
  } catch (err) {
    console.error(err);
    console.error(`Unable to fill login form.`);
    process.exit(1);
  }

  // Wait for login to be verified and second page to appear.
  try {
    await page.waitFor("#vipSkipBtn");
    await page.click("#vipSkipBtn");
  } catch (err) {
    console.error(err);
    console.error(`Unable to login, page might have timed out, try again.`);
    process.exit(1);
  }

  // Wait for AWS SAML Signin page to respond.
  let saml;
  try {
    let res = await page.waitForResponse("https://signin.aws.amazon.com/saml");
    let samlResponse = res.request().postData();
    saml = decodeURIComponent(samlResponse.split("SAMLResponse=")[1]);
  } catch (err) {
    console.error(err);
    console.error(`Unable to retrieve IdP SAML Response.`);
    process.exit(1);
  }

  // Dispose of browser.
  try {
    await page.close();
    await browser.close();
  } catch (err) {
    console.error(err);
    console.error(`Unable to close Chromium browser.`);
    process.exit(1);
  }

  return saml;
};

const parseRoles = async (saml) => {
  let rolesList;
  try {
    const xmlString = new Buffer.from(saml, "base64").toString("ascii");
    const xml = await parseString(xmlString);
    rolesList =
      xml["samlp:Response"].Assertion[0].AttributeStatement[0].Attribute[1]
        .AttributeValue;
  } catch (err) {
    console.error(err);
    console.error(`Unable to parse SAML Response and extract IAM Roles.`);
    process.exit(1);
  }

  const roles = {};
  try {
    rolesList.forEach((role) => {
      const accountId = role.match(/\d{12}/);
      const [principalArn, roleArn] = role.split(",");
      const roleName = roleArn.split("/")[1];
      if (!(accountId in roles)) {
        roles[accountId] = [];
      }
      roles[accountId].push({
        roleName: roleName,
        roleArn: roleArn,
        principalArn: principalArn,
      });
    });
  } catch (err) {
    console.error(err);
    console.error(`Unable to format IAM Roles.`);
    process.exit(1);
  }

  try {
    assert(Object.keys(roles).length > 0);
  } catch {
    console.error(`No role was returned in the SAML response.`);
    process.exit(1);
  }

  return roles;
};

const applyFlagRole = (flaggedRole, roles) => {
  let roleArn = flaggedRole.match(/((arn|aws|iam)\:){3}\:(\d){12}\:role\/\S+/);
  let isArn = Boolean(roleArn);

  let matchedRoles = {};
  let possibleMatches = [];
  Object.keys(roles).forEach((account) => {
    roles[account].forEach((role) => {
      let toMatch = isArn ? role.roleArn : role.roleName;
      let dist = leven(toMatch, flaggedRole);
      if (dist == 0) {
        if (!(account in matchedRoles)) {
          matchedRoles[account] = [];
        }
        matchedRoles[account].push(role);
      } else if (dist <= 5) {
        possibleMatches.push(role.roleArn);
      }
    });
  });

  try {
    assert(Object.keys(matchedRoles).length > 0);
  } catch {
    console.error(
      `None of the roles in the SAML response matches with the selected one.`
    );
    if (possibleMatches.length > 0) {
      let determiner = possibleMatches.length === 0 ? "this" : "one of these";
      console.log(`Did you mean ${determiner}?`);
      possibleMatches.forEach((match) => console.log(`- ${match}`));
    }
    process.exit(1);
  }

  return matchedRoles;
};

const chooseRole = async (roles) => {
  // TODO: proper logging
  var prompt = inquirer.createPromptModule();

  // Create choices array.
  let choices = [];
  Object.keys(roles).forEach((account) => {
    choices.push(new inquirer.Separator(`-- ${account} --`));
    roles[account].forEach((role) =>
      choices.push(`${role.roleName} - ${role.roleArn}`)
    );
  });

  // Prompt user to choose.
  let answer = await prompt({
    type: "list",
    name: "chosenRole",
    message: "Choose an IAM Role:",
    choices: choices,
  });

  // Extract IAM Role ARN and AWS Account ID.
  const { chosenRole } = answer;
  let roleArn = chosenRole.split(" - ")[1];
  let accountId = roleArn.match(/\d{12}/)[0];
  const role = roles[accountId].find((role) => role.roleArn === roleArn);

  return roles[accountId].find((role) => role.roleArn === roleArn);
};

const assumeRole = async (chosenRole, saml, durationSeconds) => {
  // TODO: proper logging
  var sts = new STS();
  var params = {
    DurationSeconds: durationSeconds,
    PrincipalArn: chosenRole.principalArn,
    RoleArn: chosenRole.roleArn,
    SAMLAssertion: saml,
  };
  try {
    console.log(`Assuming role ${chosenRole.roleArn}.`);
    const response = await sts.assumeRoleWithSAML(params);
    const { Credentials: credentials } = response;
    return {
      accessKey: credentials.AccessKeyId,
      secretkey: credentials.SecretAccessKey,
      token: credentials.SessionToken,
      expiration: credentials.Expiration,
    };
  } catch (err) {
    console.error(err);
    console.error("Unable to assume IAM Role.");
    process.exit(1);
  }
};

const downloadChromium = async (downloadPath) => {
  const browserFetcher = puppeteer.createBrowserFetcher({
    path: downloadPath,
    host: "https://storage.googleapis.com",
  });

  const chromeRevision = "756035";
  let progressBar = null;
  let lastDownloadedBytes = 0;
  const onProgress = (downloadedBytes, totalBytes) => {
    if (!progressBar) {
      progressBar = new ProgressBar(
        `Downloading chrome r${chromeRevision} - ${
          Math.round((totalBytes / 1024 / 1024) * 10) / 10
        } Mb [:bar] :percent :etas `,
        {
          complete: "=",
          incomplete: " ",
          width: 20,
          total: totalBytes,
        }
      );
    }
    const delta = downloadedBytes - lastDownloadedBytes;
    lastDownloadedBytes = downloadedBytes;
    progressBar.tick(delta);
  };

  try {
    console.log(
      `A special version of Chrome will be downloaded at to ${downloadPath}.
      This is a required one-time process and might take a few seconds.`
    );
    await browserFetcher.download(chromeRevision, onProgress);
    const revisionInfo = browserFetcher.revisionInfo(chromeRevision);
    console.log(`Chrome (${revisionInfo.revision}) download completed.\n`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

const cli = meow(
  `
	Usage
	  $ aws-cli-saml

	Options
    --role, -r  Accepts an IAM Role name or arn that will be used to
                authenticate if present in the SAML Response.

  Examples
    $ aws-cli-saml
    $ aws-cli-saml --role my_role_name
    $ aws-cli-saml --role arn:aws:iam::123456789101:role/my_role_name
`,
  {
    flags: {
      role: {
        type: "string",
        alias: "r",
      },
    },
  }
);

(async (flags) => {
  const downloadPath = path.join(path.dirname(process.execPath), "puppeteer");
  if (process.pkg && !fs.existsSync(downloadPath)) {
    await downloadChromium(downloadPath);
  }

  const userInfo = await getUserInfo();

  const saml = await getSAMLResponse(
    userInfo.email,
    userInfo.pass,
    userInfo.federationUrl
  );

  let roles = await parseRoles(saml);

  if (flags.role) {
    roles = applyFlagRole(flags.role, roles);
  }

  if (Object.keys(roles).length === 1) {
    chosenRole = roles[Object.keys(roles)[0]][0];
  } else {
    chosenRole = await chooseRole(roles);
  }

  const credentials = await assumeRole(
    chosenRole,
    saml,
    userInfo.durationSeconds
  );

  console.log(`aws_access_key_id = ${credentials.accessKey}`);
  console.log(`aws_secret_access_key = ${credentials.secretkey}`);
  console.log(`aws_session_token  = ${credentials.token}`);

  console.log(`Credentials will expire at ${credentials.expiration}`);
})(cli.flags);
